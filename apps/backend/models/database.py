from sqlalchemy.ext.asyncio import create_async_engine, AsyncSession, async_sessionmaker
from sqlalchemy.orm import DeclarativeBase
from sqlalchemy import (
    Column, String, Integer, BigInteger, Boolean, Float,
    Text, DateTime, Enum as SAEnum
)
from sqlalchemy.sql import func
import enum
import logging
from config import get_settings

logger = logging.getLogger(__name__)
settings = get_settings()

engine = create_async_engine(
    settings.async_database_url,
    echo=False,
    connect_args={"ssl": "require"} if "railway.app" in settings.async_database_url else {},
)
AsyncSessionLocal = async_sessionmaker(engine, expire_on_commit=False)


class Base(DeclarativeBase):
    pass


class AgentType(enum.Enum):
    BUYER = "buyer"
    SELLER = "seller"
    BOTH = "both"
    RETROBOT = "retrobot"


class JobStatus(enum.Enum):
    PENDING = "pending"
    COMPLETED = "completed"
    FAILED = "failed"
    DISPUTED = "disputed"
    RECOVERED = "recovered"


class AnomalyType(enum.Enum):
    NONE = "none"
    OVERPAYMENT = "overpayment"
    DUPLICATE = "duplicate"
    FAILED_DELIVERY = "failed_delivery"


class Agent(Base):
    __tablename__ = "agents"

    id = Column(Integer, primary_key=True, index=True)
    wallet_address = Column(String(42), unique=True, nullable=False, index=True)
    agent_id_onchain = Column(BigInteger, nullable=True)
    name = Column(String(100), nullable=False)
    description = Column(Text, nullable=True)
    agent_type = Column(SAEnum(AgentType), nullable=False)
    service_endpoint = Column(String(500), nullable=True)
    service_types = Column(Text, nullable=True)
    reputation_score = Column(Integer, default=5000)
    total_jobs = Column(Integer, default=0)
    successful_jobs = Column(Integer, default=0)
    failed_jobs = Column(Integer, default=0)
    total_earned = Column(BigInteger, default=0)
    total_spent = Column(BigInteger, default=0)
    circle_wallet_id = Column(String(200), nullable=True)
    trid_balance = Column(BigInteger, default=0)
    is_retrobot = Column(Boolean, default=False)
    active = Column(Boolean, default=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), onupdate=func.now())


class Payment(Base):
    __tablename__ = "payments"

    id = Column(Integer, primary_key=True, index=True)
    job_id_onchain = Column(BigInteger, nullable=True)
    buyer_address = Column(String(42), nullable=False, index=True)
    seller_address = Column(String(42), nullable=False, index=True)
    amount = Column(BigInteger, nullable=False)
    service_type = Column(String(100), nullable=False)
    status = Column(SAEnum(JobStatus), default=JobStatus.PENDING)
    anomaly_type = Column(SAEnum(AnomalyType), default=AnomalyType.NONE)
    anomaly_flagged = Column(Boolean, default=False)
    anomaly_reason = Column(Text, nullable=True)
    retrobot_recovery_amount = Column(BigInteger, nullable=True)
    tx_hash = Column(String(66), nullable=True)
    x402_payment_id = Column(String(200), nullable=True)
    job_hash = Column(String(66), nullable=True, index=True)
    deadline = Column(DateTime(timezone=True), nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), onupdate=func.now())


class Service(Base):
    __tablename__ = "services"

    id = Column(Integer, primary_key=True, index=True)
    seller_address = Column(String(42), nullable=False, index=True)
    service_type = Column(String(100), nullable=False)
    name = Column(String(200), nullable=False)
    description = Column(Text, nullable=True)
    price_per_call = Column(BigInteger, nullable=False)
    endpoint = Column(String(500), nullable=False)
    x402_enabled = Column(Boolean, default=True)
    calls_served = Column(Integer, default=0)
    total_earned = Column(BigInteger, default=0)
    active = Column(Boolean, default=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())


class ReputationEvent(Base):
    __tablename__ = "reputation_events"

    id = Column(Integer, primary_key=True, index=True)
    agent_address = Column(String(42), nullable=False, index=True)
    score_delta = Column(Integer, nullable=False)
    reason = Column(Text, nullable=False)
    reported_by = Column(String(42), nullable=True)
    payment_id = Column(Integer, nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())


class User(Base):
    """A Trident marketplace user — linked to Google account and/or wallet address."""
    __tablename__ = "users"

    id              = Column(Integer, primary_key=True, index=True)
    email           = Column(String(255), nullable=True, unique=True, index=True)
    google_id       = Column(String(100), nullable=True, unique=True, index=True)
    wallet_address  = Column(String(42),  nullable=True, unique=True, index=True)
    name            = Column(String(200), nullable=True)
    avatar_url      = Column(String(500), nullable=True)
    # Agent created on signup — key shown once, never stored
    agent_address   = Column(String(42),  nullable=True, unique=True, index=True)
    agent_created   = Column(Boolean, default=False)
    # Spend control — all values in micro-TRID (6 decimals, like USDC)
    max_trid_budget = Column(BigInteger, default=0)
    trid_spent      = Column(BigInteger, default=0)
    created_at      = Column(DateTime(timezone=True), server_default=func.now())
    updated_at      = Column(DateTime(timezone=True), onupdate=func.now())


async def init_db():
    try:
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
        logger.info("✅ Database tables created/verified")
    except Exception as e:
        logger.error(f"❌ Database init failed: {e}")
        logger.error(f"   URL used: {settings.async_database_url}")
        raise


async def get_db():
    async with AsyncSessionLocal() as session:
        try:
            yield session
        finally:
            await session.close()
