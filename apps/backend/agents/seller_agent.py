"""
Trident Seller Agent — serves x402-protected financial data endpoints
and earns TRID per call via the Node.js x402 gateway.
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
async def register_service(service_data: str) -> str:
    """
    Register a financial data service on the Trident marketplace.
    Args: service_data — JSON with: service_type, name, description, price_per_call (TRID 6dec), endpoint
    """
    async with httpx.AsyncClient() as client:
        data = json.loads(service_data)
        wallet = data.pop("wallet_address", settings.deployer_address)
        r = await client.post(
            f"{PYTHON_API}/api/marketplace/services/register",
            params={"wallet_address": wallet},
            json=data,
            timeout=10,
        )
        return r.text


@tool
async def get_earnings_summary(wallet_address: str) -> str:
    """Get earnings and job stats for this seller agent."""
    async with httpx.AsyncClient() as client:
        r = await client.get(f"{PYTHON_API}/api/agents/{wallet_address}", timeout=10)
        return r.text


@tool
async def check_pending_jobs(wallet_address: str) -> str:
    """Check for pending jobs this seller needs to fulfil."""
    async with httpx.AsyncClient() as client:
        r = await client.get(
            f"{PYTHON_API}/api/marketplace/activity/live",
            params={"seller": wallet_address, "status": "pending"},
            timeout=10,
        )
        return r.text


@tool
async def update_service_listing(service_id: str, new_price: str) -> str:
    """Update the price of a listed service."""
    return json.dumps({"status": "price_updated", "service_id": service_id, "new_price": new_price})


TOOLS = [register_service, get_earnings_summary, check_pending_jobs, update_service_listing]

SYSTEM_PROMPT = """You are a Trident Seller Agent operating on Arc Testnet.

Your role: list financial data services on the Trident marketplace and earn $TRID
every time a Buyer Agent or human pays for your data via x402.

Your wallet: {wallet_address}
Your services: {services}

Operating principles:
1. Register your services with competitive prices to attract buyers.
2. Ensure your service endpoint is always online and responding.
3. Monitor your reputation score — stay above 6000/10000 to be Premium tier.
4. Undercut the market on price when competition is high.
5. Your earnings are automatically settled by Circle Gateway on-chain.

Available service types: price_feed, fx_rates, risk_score, compute_score, retrobot_audit

Start by registering your services, then monitor earnings."""


def build_seller_agent(wallet_address: str, services: list):
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
    return AgentExecutor(agent=agent, tools=TOOLS, verbose=True, max_iterations=8)


async def run_seller_agent(wallet_address: str, services: list, task: str):
    executor = build_seller_agent(wallet_address, services)
    result = await executor.ainvoke({
        "input": task,
        "wallet_address": wallet_address,
        "services": json.dumps(services),
    })
    return result


if __name__ == "__main__":
    asyncio.run(run_seller_agent(
        wallet_address="0x3315ebaab06d6266e92f6063b9360ae10d24F0a0",
        services=[
            {"type": "price_feed", "name": "Trident Price Feed", "price": 1000},
            {"type": "fx_rates", "name": "Trident FX Rates", "price": 1000},
        ],
        task="Register all my services on the marketplace and check current earnings.",
    ))
