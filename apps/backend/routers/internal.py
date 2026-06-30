"""
Internal API endpoints — called by Node backend, not exposed to end users.

POST /api/internal/record-payment
    Records a real Circle Gateway x402 payment made by a buyer agent.
    Called by apps/node-backend/src/buyerAgents.ts after gateway.pay() succeeds.
"""
from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from pydantic import BaseModel
from typing import Optional
import logging
import math

from models.database import get_db, Agent, Payment, Service, AgentType, JobStatus, AnomalyType

router = APIRouter()
logger = logging.getLogger(__name__)

# 1 USDC = 1_000_000 micro-units (6 decimals); TRID also 6 decimals
# We store amounts in TRID micro-units (same scale as USDC for testnet parity)
USDC_TO_TRID = 1_000_000  # 1 USDC = 1 TRID on testnet (1:1 peg for demo)


class RecordPaymentRequest(BaseModel):
    buyer_address: str
    buyer_name: Optional[str] = "Circle Agent"
    seller_address: str
    service_type: str
    amount_usdc: str          # e.g. "0.001" — from GatewayClient.pay() formattedAmount
    tx_ref: Optional[str] = None
    source: Optional[str] = "circle_gateway_x402"


@router.post("/record-payment")
async def record_payment(req: RecordPaymentRequest, db: AsyncSession = Depends(get_db)):
    """
    Record a real Circle Gateway x402 payment in the DB.
    Called by the Node backend buyer agents after every successful gateway.pay() call.
    """
    try:
        usdc_float = float(req.amount_usdc.replace(" USDC", "").strip())
    except ValueError:
        usdc_float = 0.001

    amount_trid = int(usdc_float * USDC_TO_TRID)  # micro-units

    # Ensure buyer agent exists in DB
    buyer_result = await db.execute(
        select(Agent).where(Agent.wallet_address == req.buyer_address.lower())
    )
    buyer = buyer_result.scalar_one_or_none()
    if not buyer:
        buyer = Agent(
            wallet_address=req.buyer_address.lower(),
            name=req.buyer_name or "Circle Agent",
            agent_type=AgentType.BUYER,
            reputation_score=7500,
            total_jobs=0,
            successful_jobs=0,
        )
        db.add(buyer)

    # Ensure seller exists in DB
    seller_result = await db.execute(
        select(Agent).where(Agent.wallet_address == req.seller_address.lower())
    )
    seller = seller_result.scalar_one_or_none()

    # Record the real payment
    payment = Payment(
        buyer_address=req.buyer_address.lower(),
        seller_address=req.seller_address.lower(),
        amount=amount_trid,
        service_type=req.service_type,
        status=JobStatus.COMPLETED,
        anomaly_type=AnomalyType.NONE,
        anomaly_flagged=False,
        anomaly_reason=None,
    )
    db.add(payment)

    # Update buyer stats
    buyer.total_jobs = (buyer.total_jobs or 0) + 1
    buyer.successful_jobs = (buyer.successful_jobs or 0) + 1
    buyer.total_spent = (buyer.total_spent or 0) + amount_trid
    buyer.reputation_score = min(10000, (buyer.reputation_score or 5000) + 3)

    # Update seller stats
    if seller:
        seller.total_jobs = (seller.total_jobs or 0) + 1
        seller.successful_jobs = (seller.successful_jobs or 0) + 1
        seller.total_earned = (seller.total_earned or 0) + amount_trid
        seller.reputation_score = min(10000, (seller.reputation_score or 5000) + 5)

    # Update service call count + earnings
    service_result = await db.execute(
        select(Service).where(
            Service.service_type == req.service_type,
            Service.seller_address == req.seller_address.lower(),
            Service.active == True,
        )
    )
    service = service_result.scalar_one_or_none()
    if service:
        service.calls_served = (service.calls_served or 0) + 1
        service.total_earned = (service.total_earned or 0) + amount_trid

    await db.commit()

    logger.info(
        f"[Internal] ✅ Recorded real x402 payment: "
        f"{req.buyer_address[:8]}… paid {usdc_float:.4f} USDC "
        f"for {req.service_type} (tx: {req.tx_ref or 'N/A'})"
    )

    return {
        "status": "recorded",
        "buyer": req.buyer_address,
        "service_type": req.service_type,
        "amount_trid": amount_trid,
        "source": req.source,
    }
