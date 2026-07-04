"""
User-Agent endpoints.

GET  /api/user-agent/recommend?task=price_feed
     → Returns ranked list of agents that can serve the task (by reputation DESC, price ASC)

POST /api/user-agent/hire
     { service_type, params?, auto_select? }
     → Budget check → pick best agent → call Node /hire (x402 USDC via Gateway)
     → Deduct TRID from user budget → record payment → return data

TRID → USDC conversion rate (testnet): 1,000 micro-TRID = $0.001 USDC
i.e. price_per_call micro-TRID / 1_000_000 * 0.001 USDC per call
"""
import logging
import httpx
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select

from models.database import get_db, User, Agent, Service, AgentType
from routers.auth import get_current_user
from config import get_settings

router   = APIRouter()
logger   = logging.getLogger(__name__)
settings = get_settings()

NODE_API = getattr(settings, "node_api_url", None) or "http://localhost:3001"

# Testnet conversion rate: 1 TRID (1_000_000 micro) = $0.001 USDC
# So 1 micro-TRID = $0.000000001 USDC. For gateway: amount_usdc = trid_micro / 1e9
MICRO_TRID_TO_USDC = 1e-9  # 1 micro-TRID → USDC value

# ── Schemas ───────────────────────────────────────────────────────────────────

class HireRequest(BaseModel):
    service_type: str
    params: dict = {}
    auto_select: bool = True            # if True, pick best agent automatically
    agent_private_key: str | None = None  # user's decrypted EOA key — forwarded to Node
    # NOTE: only in-flight over HTTPS, never logged or stored here

# ── Routes ────────────────────────────────────────────────────────────────────

@router.get("/recommend")
async def recommend_agents(
    task: str,
    db: AsyncSession = Depends(get_db),
):
    """
    Return the best agents for a given task, ranked by reputation (desc) then price (asc).
    task should match a service_type: price_feed | fx_rates | risk_score | compute_score | retrobot_audit
    """
    result = await db.execute(
        select(Service, Agent)
        .join(Agent, Service.seller_address == Agent.wallet_address)
        .where(Service.service_type == task)
        .where(Service.active == True)
        .where(Agent.active == True)
        .order_by(Agent.reputation_score.desc(), Service.price_per_call.asc())
        .limit(5)
    )
    rows = result.all()

    if not rows:
        raise HTTPException(status_code=404, detail=f"No agents available for task: {task}")

    return {
        "task": task,
        "agents": [
            {
                "seller_address": svc.seller_address,
                "agent_name": agent.name,
                "service_name": svc.name,
                "price_per_call": svc.price_per_call,
                "price_trid_display": f"{svc.price_per_call / 1_000_000:.4f} TRID",
                "reputation_score": agent.reputation_score,
                "calls_served": svc.calls_served,
                "x402_enabled": svc.x402_enabled,
                "endpoint": svc.endpoint,
            }
            for svc, agent in rows
        ],
    }


@router.post("/hire")
async def user_agent_hire(
    body: HireRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """
    User's agent hires the best available agent for a task.

    1. Check TRID budget
    2. Find best agent (recommend)
    3. Get service price
    4. Deduct TRID from budget
    5. Call Node /hire → x402 USDC Circle Gateway payment
    6. Record payment
    7. Return data + payment proof
    """
    # ── 1. Find best service ──────────────────────────────────────────────────
    result = await db.execute(
        select(Service, Agent)
        .join(Agent, Service.seller_address == Agent.wallet_address)
        .where(Service.service_type == body.service_type)
        .where(Service.active == True)
        .where(Agent.active == True)
        .order_by(Agent.reputation_score.desc(), Service.price_per_call.asc())
        .limit(1)
    )
    row = result.first()
    if not row:
        raise HTTPException(status_code=404, detail=f"No agent available for: {body.service_type}")

    service, agent = row

    # ── 2. Budget check ───────────────────────────────────────────────────────
    if user.max_trid_budget and user.max_trid_budget > 0:
        remaining = (user.max_trid_budget or 0) - (user.trid_spent or 0)
        if remaining < service.price_per_call:
            raise HTTPException(
                status_code=402,
                detail={
                    "error": "budget_exceeded",
                    "budget_remaining_trid": remaining / 1_000_000,
                    "service_cost_trid": service.price_per_call / 1_000_000,
                    "message": f"Budget remaining ({remaining / 1_000_000:.4f} TRID) is less than service cost ({service.price_per_call / 1_000_000:.4f} TRID). Increase your budget.",
                },
            )

    # ── 3. Call Node /hire (x402 USDC Circle Gateway) ────────────────────────
    buyer_addr = user.agent_address or user.wallet_address or "0x0000000000000000000000000000000000000001"
    node_payload: dict = {
        "service_type": body.service_type,
        "params": body.params,
        "buyer_address": buyer_addr,
    }
    # Forward user's private key so Node can pay from their own Gateway balance.
    # The key is never logged here — httpx sends it over HTTPS only.
    if body.agent_private_key:
        node_payload["agent_private_key"] = body.agent_private_key

    try:
        async with httpx.AsyncClient(timeout=25) as client:
            r = await client.post(f"{NODE_API}/hire", json=node_payload)
    except httpx.RequestError as e:
        raise HTTPException(status_code=503, detail=f"Node backend unreachable: {e}")

    if r.status_code == 402:
        err = r.json()
        raise HTTPException(status_code=402, detail=err.get("message", "x402 payment failed"))
    if r.status_code != 200:
        raise HTTPException(status_code=r.status_code, detail=r.text)

    payload = r.json()

    # ── 4. Deduct TRID from user budget ───────────────────────────────────────
    user.trid_spent = (user.trid_spent or 0) + service.price_per_call
    await db.commit()

    # ── 5. Also deduct from agent's trid_balance if agent exists ──────────────
    if user.agent_address:
        agent_result = await db.execute(
            select(Agent).where(Agent.wallet_address == user.agent_address.lower())
        )
        user_agent = agent_result.scalar_one_or_none()
        if user_agent:
            user_agent.trid_balance = max(0, (user_agent.trid_balance or 0) - service.price_per_call)
            user_agent.total_spent  = (user_agent.total_spent or 0) + service.price_per_call
            user_agent.total_jobs   = (user_agent.total_jobs or 0) + 1
            user_agent.successful_jobs = (user_agent.successful_jobs or 0) + 1
            await db.commit()

    # ── 6. TRID → USDC conversion note ───────────────────────────────────────
    trid_in_usdc = service.price_per_call * MICRO_TRID_TO_USDC

    return {
        "data": payload.get("data", payload),
        "service_type": body.service_type,
        "agent_used": {
            "name": agent.name,
            "address": service.seller_address,
            "reputation_score": agent.reputation_score,
        },
        "payment": {
            "trid_charged": service.price_per_call,
            "trid_display": f"{service.price_per_call / 1_000_000:.4f} TRID",
            "usdc_gateway": payload.get("amount_paid"),
            "trid_to_usdc_rate": "1 TRID = $0.001 USDC (testnet)",
            "trid_value_in_usdc": f"${trid_in_usdc:.6f}",
            "x402": payload.get("x402", False),
            "transaction_ref": payload.get("transaction"),
            "paid_by_agent": payload.get("paid_by", buyer_addr),
            "payment_source": payload.get("payment_source", "shared_agent"),
        },
        "budget": {
            "max_trid_budget": user.max_trid_budget,
            "trid_spent": user.trid_spent,
            "remaining": max(0, (user.max_trid_budget or 0) - (user.trid_spent or 0)),
            "remaining_display": f"{max(0, (user.max_trid_budget or 0) - (user.trid_spent or 0)) / 1_000_000:.4f} TRID",
        },
    }


@router.get("/budget")
async def get_budget(user: User = Depends(get_current_user)):
    """Get current user's budget status."""
    remaining = max(0, (user.max_trid_budget or 0) - (user.trid_spent or 0))
    return {
        "max_trid_budget": user.max_trid_budget,
        "max_trid_budget_display": f"{(user.max_trid_budget or 0) / 1_000_000:.4f} TRID",
        "trid_spent": user.trid_spent,
        "trid_spent_display": f"{(user.trid_spent or 0) / 1_000_000:.4f} TRID",
        "remaining": remaining,
        "remaining_display": f"{remaining / 1_000_000:.4f} TRID",
        "pct_used": round((user.trid_spent or 0) / max(1, user.max_trid_budget or 1) * 100, 1),
    }
