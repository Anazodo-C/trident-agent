"""
Retrobot Agent — passive monitor and active recovery orchestrator.
Runs as a background process scanning all marketplace payments in real time.
"""
import asyncio
import json
import logging
import httpx
from langchain_anthropic import ChatAnthropic
from langchain.agents import AgentExecutor, create_tool_calling_agent
from langchain_core.prompts import ChatPromptTemplate
from langchain_core.tools import tool
from config import get_settings

logger = logging.getLogger(__name__)
settings = get_settings()

PYTHON_API = f"http://localhost:{settings.backend_port}"


@tool
async def get_recent_payments(limit: str = "20") -> str:
    """Fetch recent marketplace payments to scan for anomalies."""
    async with httpx.AsyncClient() as client:
        r = await client.get(f"{PYTHON_API}/api/marketplace/activity/live", params={"limit": limit}, timeout=10)
        return r.text


@tool
async def scan_payment_for_anomalies(payment_data: str) -> str:
    """
    Run Retrobot anomaly detection on a payment.
    Args: payment_data — JSON with: payment_id, buyer_address, seller_address, amount, service_type, job_hash
    """
    async with httpx.AsyncClient() as client:
        data = json.loads(payment_data)
        r = await client.post(f"{PYTHON_API}/api/retrobot/scan", json=data, timeout=15)
        return r.text


@tool
async def get_current_anomalies(wallet_address: str = "") -> str:
    """Get all currently flagged anomalies, optionally filtered by wallet."""
    async with httpx.AsyncClient() as client:
        params = {"wallet_address": wallet_address} if wallet_address else {}
        r = await client.get(f"{PYTHON_API}/api/retrobot/anomalies", params=params, timeout=10)
        return r.text


@tool
async def initiate_recovery(payment_id: str, requester_address: str) -> str:
    """
    Trigger on-chain recovery for a confirmed anomaly.
    Args: payment_id — database payment ID; requester_address — buyer's wallet.
    """
    async with httpx.AsyncClient() as client:
        r = await client.post(
            f"{PYTHON_API}/api/retrobot/recover",
            json={"payment_id": int(payment_id), "requester_address": requester_address},
            timeout=30,
        )
        return r.text


@tool
async def get_retrobot_stats() -> str:
    """Get Retrobot performance stats — detections, recoveries, total TRID saved."""
    async with httpx.AsyncClient() as client:
        r = await client.get(f"{PYTHON_API}/api/retrobot/stats", timeout=10)
        return r.text


@tool
async def audit_wallet(wallet_address: str, lookback_hours: str = "24") -> str:
    """
    Run a full 24-hour payment audit for a wallet address.
    Args: wallet_address — 0x address to audit; lookback_hours — history window.
    """
    async with httpx.AsyncClient() as client:
        r = await client.post(
            f"{PYTHON_API}/api/retrobot/audit",
            json={"wallet_address": wallet_address, "lookback_hours": int(lookback_hours)},
            timeout=20,
        )
        return r.text


TOOLS = [
    get_recent_payments,
    scan_payment_for_anomalies,
    get_current_anomalies,
    initiate_recovery,
    get_retrobot_stats,
    audit_wallet,
]

SYSTEM_PROMPT = """You are Retrobot — Trident's autonomous payment recovery agent on Arc Testnet.

Your mission: protect every payment on the Trident marketplace. Detect overpayments,
duplicate transactions, and delivery failures. Recover funds automatically when confirmed.

Operating principles:
1. Scan every new payment immediately.
2. Flag anomalies with high confidence (>0.7) automatically.
3. For low-confidence anomalies, reason carefully before flagging.
4. Only initiate recovery when anomaly is confirmed — false positives damage trust.
5. Track your detection rate — target >95% precision.
6. You are also listed as a paid x402 service — external agents can hire you.

Current scan task: {task}

Begin by checking recent payments, then scan each one."""


def build_retrobot_agent():
    llm = ChatAnthropic(
        model="claude-sonnet-4-6",
        anthropic_api_key=settings.anthropic_api_key,
    )
    prompt = ChatPromptTemplate.from_messages([
        ("system", SYSTEM_PROMPT),
        ("human", "{input}"),
        ("placeholder", "{agent_scratchpad}"),
    ])
    agent = create_tool_calling_agent(llm, TOOLS, prompt)
    return AgentExecutor(agent=agent, tools=TOOLS, verbose=True, max_iterations=15, handle_parsing_errors=True)


async def run_retrobot_scan(task: str = "Scan all recent payments for anomalies and initiate recovery on confirmed cases."):
    executor = build_retrobot_agent()
    result = await executor.ainvoke({"input": task, "task": task})
    return result


async def retrobot_loop(interval_seconds: int = 30):
    """Continuous monitoring loop — runs Retrobot every N seconds."""
    logger.info("🔱 Retrobot monitoring loop started")
    while True:
        try:
            logger.info("🔍 Retrobot scan cycle starting...")
            result = await run_retrobot_scan()
            logger.info(f"✅ Scan complete: {result.get('output', '')[:200]}")
        except Exception as e:
            logger.error(f"Retrobot scan failed: {e}")
        await asyncio.sleep(interval_seconds)


if __name__ == "__main__":
    asyncio.run(retrobot_loop(interval_seconds=60))
