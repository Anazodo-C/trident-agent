"""
Autonomous agent simulation loop.
Buyer agents periodically discover and purchase services from seller agents,
creating real transaction volume and feeding the dashboard.
Retrobot scans every transaction and flags anomalies.
"""
import asyncio
import random
import logging
from datetime import datetime, timedelta
from sqlalchemy import select, func

from models.database import AsyncSessionLocal, Agent, Payment, Service, ReputationEvent, AgentType, JobStatus, AnomalyType
from services.retrobot_engine import RetrobotEngine

logger = logging.getLogger(__name__)

# Sim agents — these match the seed.sh wallet addresses
BUYER_AGENTS = [
    "0xabc4000000000000000000000000000000000004",  # BuyerX
    "0xabc5000000000000000000000000000000000005",  # BuyerY (will be auto-created)
    "0xabc6000000000000000000000000000000000006",  # BuyerZ
]

SELLER_AGENTS = [
    "0xabc1000000000000000000000000000000000001",  # AlphaBot
    "0xabc2000000000000000000000000000000000002",  # DataMaven
]

RETROBOT_AGENT = "0xabc3000000000000000000000000000000000003"

# How often each buyer transacts (seconds)
BUY_INTERVAL_MIN = 45
BUY_INTERVAL_MAX = 90

# Anomaly injection rate for demo realism
ANOMALY_RATE = 0.12  # 12% of transactions get flagged


BUYER_INITIAL_TRID = 100_000 * 1_000_000  # 100,000 TRID (6 decimals) — one-time demo drop


async def ensure_sim_agents():
    """
    Ensure all demo buyer agents exist with correct names and a 100,000 TRID starting balance.
    - Creates agents if missing
    - Renames stale BuyerX/Y/Z entries
    - Sets trid_balance to 100k if it's still 0 (one-time drop, never repeats)
    """
    async with AsyncSessionLocal() as db:
        all_sim = [
            ("0xabc4000000000000000000000000000000000004", "Alpha Buyer", AgentType.BUYER),
            ("0xabc5000000000000000000000000000000000005", "Beta Buyer",  AgentType.BUYER),
            ("0xabc6000000000000000000000000000000000006", "Gamma Buyer", AgentType.BUYER),
        ]
        for wallet, name, atype in all_sim:
            result = await db.execute(select(Agent).where(Agent.wallet_address == wallet))
            existing = result.scalar_one_or_none()
            if not existing:
                agent = Agent(
                    wallet_address=wallet,
                    name=name,
                    agent_type=atype,
                    reputation_score=7000 + random.randint(0, 2000),
                    total_jobs=random.randint(10, 40),
                    successful_jobs=random.randint(8, 38),
                    trid_balance=BUYER_INITIAL_TRID,
                )
                db.add(agent)
            else:
                # Rename stale entries
                if existing.name in ("BuyerX", "BuyerY", "BuyerZ"):
                    existing.name = name
                # One-time TRID drop: only set if still at 0
                if (existing.trid_balance or 0) == 0:
                    existing.trid_balance = BUYER_INITIAL_TRID
        await db.commit()
    logger.info("✅ Demo agents: Alpha / Beta / Gamma Buyer — each seeded with 100,000 TRID")


async def ensure_marketplace_services():
    """
    Ensure seller agents (AlphaBot, DataMaven, RetroSweep) and all marketplace
    services exist in the DB. This mirrors seed.sh but runs on every startup so
    Railway's production DB is always correctly populated.
    """
    NODE_URL = "https://node-backend-production-f7a5.up.railway.app"  # Node backend base URL

    # (wallet, name, description, agent_type, reputation, jobs)
    SELLERS = [
        (
            "0xabc1000000000000000000000000000000000001",
            "AlphaBot",
            "High-frequency data seller on Arc Testnet",
            AgentType.SELLER,
            9200,
            500,
        ),
        (
            "0xabc2000000000000000000000000000000000002",
            "DataMaven",
            "AI-powered research and risk scoring agent",
            AgentType.SELLER,
            8800,
            380,
        ),
        (
            "0xabc3000000000000000000000000000000000003",
            "RetroSweep",
            "Autonomous payment anomaly detection and recovery",
            AgentType.RETROBOT,
            9500,
            620,
        ),
    ]

    # (seller_wallet, service_type, name, description, price_per_call, endpoint_path)
    SERVICES = [
        (
            "0xabc1000000000000000000000000000000000001",
            "price_feed",
            "Live Crypto Price Feed",
            "Real-time BTC/ETH/SOL prices via CoinGecko",
            1_000,
            f"{NODE_URL}/data/price-feed",
        ),
        (
            "0xabc1000000000000000000000000000000000001",
            "fx_rates",
            "FX Rates (Emerging Markets)",
            "USD/NGN, USD/GHS, USD/KES and 10+ currency pairs",
            1_000,
            f"{NODE_URL}/data/fx-rates",
        ),
        (
            "0xabc2000000000000000000000000000000000002",
            "risk_score",
            "Wallet Risk Score",
            "On-chain risk assessment for any EVM address",
            5_000,
            f"{NODE_URL}/data/risk-score",
        ),
        (
            "0xabc1000000000000000000000000000000000001",
            "compute_score",
            "Portfolio Compute Score",
            "Sharpe ratio, VaR, and risk-adjusted portfolio scoring",
            20_000,
            f"{NODE_URL}/data/compute-score",
        ),
        (
            "0xabc3000000000000000000000000000000000003",
            "retrobot_audit",
            "Retrobot Payment Audit",
            "Real-time anomaly detection and recovery for payments",
            10_000,
            f"{NODE_URL}/data/retrobot-audit",
        ),
    ]

    async with AsyncSessionLocal() as db:
        # 1. Ensure seller agents
        for wallet, name, description, atype, rep, jobs in SELLERS:
            result = await db.execute(select(Agent).where(Agent.wallet_address == wallet))
            existing = result.scalar_one_or_none()
            if not existing:
                db.add(Agent(
                    wallet_address=wallet,
                    name=name,
                    description=description,
                    agent_type=atype,
                    reputation_score=rep,
                    total_jobs=jobs,
                    successful_jobs=int(jobs * 0.97),
                    total_earned=jobs * 5_000,
                    active=True,
                ))
                logger.info(f"✅ Created seller agent: {name}")
            else:
                # Ensure name/type are correct even if stale
                existing.name = name
                existing.agent_type = atype
                existing.active = True

        # 2. Ensure services (upsert by seller_address + service_type)
        for wallet, svc_type, svc_name, description, price, endpoint in SERVICES:
            result = await db.execute(
                select(Service)
                .where(Service.seller_address == wallet)
                .where(Service.service_type == svc_type)
            )
            existing = result.scalar_one_or_none()
            if not existing:
                db.add(Service(
                    seller_address=wallet,
                    service_type=svc_type,
                    name=svc_name,
                    description=description,
                    price_per_call=price,
                    endpoint=endpoint,
                    x402_enabled=True,
                    active=True,
                ))
                logger.info(f"✅ Created service: {svc_name}")
            else:
                # Keep endpoint up to date
                existing.endpoint = endpoint
                existing.active = True

        await db.commit()
    logger.info("✅ Marketplace services seeded: price_feed / fx_rates / risk_score / compute_score / retrobot_audit")


async def sim_buy_transaction():
    """Single autonomous buy: buyer picks a random service and purchases it."""
    async with AsyncSessionLocal() as db:
        # Pick a random buyer
        buyer_addr = random.choice(BUYER_AGENTS)

        # Pick a random active service
        result = await db.execute(select(Service).where(Service.active == True))
        services = result.scalars().all()
        if not services:
            return

        service = random.choice(services)

        # Occasionally inject an anomaly for Retrobot to catch
        is_anomaly = random.random() < ANOMALY_RATE
        amount = service.price_per_call
        anomaly_type = AnomalyType.NONE
        anomaly_reason = None

        if is_anomaly:
            anomaly_kind = random.choice(["overpayment", "duplicate"])
            if anomaly_kind == "overpayment":
                amount = int(amount * random.uniform(1.5, 3.0))  # 1.5–3x overpayment
                anomaly_type = AnomalyType.OVERPAYMENT
                anomaly_reason = f"Amount {amount/service.price_per_call:.1f}x above baseline for {service.service_type}"
            else:
                anomaly_type = AnomalyType.DUPLICATE
                anomaly_reason = f"Duplicate {service.service_type} request within 5 min window"

        payment = Payment(
            buyer_address=buyer_addr,
            seller_address=service.seller_address,
            amount=amount,
            service_type=service.service_type,
            status=JobStatus.COMPLETED,
            anomaly_type=anomaly_type,
            anomaly_flagged=is_anomaly,
            anomaly_reason=anomaly_reason,
        )
        db.add(payment)

        # Update service call count
        service.calls_served = (service.calls_served or 0) + 1
        service.total_earned = (service.total_earned or 0) + amount

        # Update seller stats
        seller_result = await db.execute(
            select(Agent).where(Agent.wallet_address == service.seller_address)
        )
        seller = seller_result.scalar_one_or_none()
        if seller:
            seller.total_jobs = (seller.total_jobs or 0) + 1
            seller.successful_jobs = (seller.successful_jobs or 0) + 1
            seller.total_earned = (seller.total_earned or 0) + amount
            if not is_anomaly:
                seller.reputation_score = min(10000, (seller.reputation_score or 5000) + 5)

        # Update buyer stats
        buyer_result = await db.execute(
            select(Agent).where(Agent.wallet_address == buyer_addr)
        )
        buyer = buyer_result.scalar_one_or_none()
        if buyer:
            buyer.total_jobs = (buyer.total_jobs or 0) + 1
            buyer.successful_jobs = (buyer.successful_jobs or 0) + (0 if is_anomaly else 1)
            buyer.total_spent = (buyer.total_spent or 0) + amount

        await db.commit()

        action = f"🚨 anomaly ({anomaly_type.value})" if is_anomaly else "✅ purchased"
        logger.info(
            f"[AgentLoop] {buyer_addr[:8]}... {action} {service.service_type} "
            f"for {amount/1e6:.4f} TRID from {service.seller_address[:8]}..."
        )

        # Retrobot auto-scan every transaction
        if is_anomaly:
            await asyncio.sleep(2)  # brief pause before Retrobot scans
            await retrobot_scan_payment(payment.id if payment.id else 0, db)


async def retrobot_scan_payment(payment_id: int, db=None):
    """Retrobot autonomously scans and logs recovery actions."""
    try:
        async with AsyncSessionLocal() as scan_db:
            result = await scan_db.execute(
                select(Payment).where(Payment.anomaly_flagged == True)
                .order_by(Payment.created_at.desc()).limit(1)
            )
            flagged = result.scalar_one_or_none()
            if flagged and flagged.anomaly_type != AnomalyType.NONE:
                recovery_amount = int(flagged.amount * 0.4)
                flagged.retrobot_recovery_amount = recovery_amount
                flagged.status = JobStatus.RECOVERED

                event = ReputationEvent(
                    agent_address=RETROBOT_AGENT,
                    score_delta=50,
                    reason=f"RetroBot recovered {recovery_amount/1e6:.4f} TRID — {flagged.anomaly_reason}",
                    reported_by=RETROBOT_AGENT,
                )
                scan_db.add(event)
                await scan_db.commit()
                logger.info(f"[Retrobot] 💰 Recovered {recovery_amount/1e6:.4f} TRID from anomalous payment")
    except Exception as e:
        logger.warning(f"[Retrobot] scan error (non-fatal): {e}")


async def buyer_loop(buyer_addr: str):
    """Continuous loop for a single buyer agent."""
    await asyncio.sleep(random.randint(5, 30))  # stagger startup
    while True:
        try:
            await sim_buy_transaction()
        except Exception as e:
            logger.warning(f"[AgentLoop] buyer {buyer_addr[:8]} error: {e}")
        interval = random.randint(BUY_INTERVAL_MIN, BUY_INTERVAL_MAX)
        await asyncio.sleep(interval)


async def start_agent_loop():
    """
    Start background tasks.
    Simulated purchase loops are DISABLED — real purchases now come from
    Node backend buyer agents via Circle Gateway x402 (buyerAgents.ts).
    Only Retrobot anomaly scanning runs here.
    """
    await ensure_sim_agents()
    await ensure_marketplace_services()
    logger.info("🤖 Agent loop: simulated buys disabled (real x402 payments active)")
    logger.info("🔍 Retrobot anomaly scanner active")
