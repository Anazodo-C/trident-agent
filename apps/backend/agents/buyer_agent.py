"""
Trident Buyer Agent — LangChain agent that discovers and pays for
financial data services on the Trident marketplace using x402 nanopayments.
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

NODE_API = settings.node_backend_url  # x402 gateway
PYTHON_API = f"http://localhost:{settings.backend_port}"


@tool
async def list_marketplace_services(service_type: str = "") -> str:
    """List available financial intelligence services on the Trident marketplace."""
    async with httpx.AsyncClient() as client:
        params = {"service_type": service_type} if service_type else {}
        r = await client.get(f"{PYTHON_API}/api/marketplace/services", params=params, timeout=10)
        return r.text


@tool
async def get_price_feed(symbols: str = "BTC,ETH") -> str:
    """
    Buy a live crypto price feed via x402 payment.
    Args: symbols — comma-separated list e.g. 'BTC,ETH,SOL'
    Cost: 0.001 TRID per call.
    """
    async with httpx.AsyncClient() as client:
        r = await client.get(
            f"{NODE_API}/price-feed",
            params={"symbols": symbols},
            timeout=15,
        )
        return r.text


@tool
async def get_fx_rates(base: str = "USD", targets: str = "EUR,GBP,NGN") -> str:
    """
    Buy live FX rates via x402 payment.
    Args: base — base currency; targets — comma-separated target currencies.
    Cost: 0.001 TRID per call.
    """
    async with httpx.AsyncClient() as client:
        r = await client.get(
            f"{NODE_API}/fx-rates",
            params={"base": base, "targets": targets},
            timeout=15,
        )
        return r.text


@tool
async def scan_for_anomalies(payment_data: str) -> str:
    """
    Submit a payment to Retrobot for anomaly scanning.
    Args: payment_data — JSON string with fields: payment_id, buyer_address, seller_address, amount, service_type
    Cost: 0.001 TRID (paid to Retrobot marketplace listing).
    """
    async with httpx.AsyncClient() as client:
        data = json.loads(payment_data)
        r = await client.post(f"{PYTHON_API}/api/retrobot/scan", json=data, timeout=15)
        return r.text


@tool
async def check_agent_reputation(wallet_address: str) -> str:
    """
    Check the on-chain reputation of a seller agent before paying.
    Args: wallet_address — seller's 0x address.
    """
    async with httpx.AsyncClient() as client:
        r = await client.get(f"{PYTHON_API}/api/reputation/agent/{wallet_address}", timeout=10)
        return r.text


TOOLS = [
    list_marketplace_services,
    get_price_feed,
    get_fx_rates,
    scan_for_anomalies,
    check_agent_reputation,
]

SYSTEM_PROMPT = """You are a Trident Buyer Agent operating on Arc Testnet.

Your goal: discover and purchase financial intelligence services from the Trident marketplace
using x402 nanopayments denominated in $TRID.

Your wallet: {wallet_address}
Your TRID budget: {trid_budget} TRID
Current task: {task}

Operating principles:
1. Always check seller reputation before paying — skip sellers below 3000/10000.
2. Scan each payment with Retrobot before confirming — never pay twice for the same service in 5 minutes.
3. If a service returns HTTP 402, the x402 middleware handles payment automatically.
4. Log every purchase with amount paid and data received.
5. Stop if budget drops below 0.5 TRID.

Start by listing available services, then execute the task."""


def build_buyer_agent(wallet_address: str, trid_budget: float = 5.0):
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
    return AgentExecutor(
        agent=agent,
        tools=TOOLS,
        verbose=True,
        max_iterations=10,
        handle_parsing_errors=True,
    ), {"wallet_address": wallet_address, "trid_budget": trid_budget}


async def run_buyer_agent(wallet_address: str, task: str, trid_budget: float = 5.0):
    executor, agent_vars = build_buyer_agent(wallet_address, trid_budget)
    result = await executor.ainvoke({
        "input": task,
        "wallet_address": wallet_address,
        "trid_budget": trid_budget,
        "task": task,
    })
    return result


if __name__ == "__main__":
    asyncio.run(run_buyer_agent(
        wallet_address="0x3315ebaab06d6266e92f6063b9360ae10d24F0a0",
        task="Get the current BTC and ETH prices, then get FX rates for USD to NGN and EUR.",
        trid_budget=5.0,
    ))
