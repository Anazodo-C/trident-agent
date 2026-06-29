from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from contextlib import asynccontextmanager
import logging

from routers import marketplace, retrobot, reputation, agents, faucet, stats
from models.database import init_db
from middleware.auth import AuthMiddleware
from services.agent_loop import start_agent_loop

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("🔱 Trident Agent API starting up...")
    await init_db()
    logger.info("✅ Database initialised")
    await start_agent_loop()
    logger.info("🤖 Autonomous agent loop started")
    yield
    logger.info("🔱 Trident Agent API shutting down...")


app = FastAPI(
    title="Trident Agent API",
    description="Agentic financial intelligence marketplace on Arc Testnet",
    version="1.0.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(marketplace.router, prefix="/api/marketplace", tags=["Marketplace"])
app.include_router(retrobot.router, prefix="/api/retrobot", tags=["Retrobot"])
app.include_router(reputation.router, prefix="/api/reputation", tags=["Reputation"])
app.include_router(agents.router, prefix="/api/agents", tags=["Agents"])
app.include_router(faucet.router, prefix="/api/faucet", tags=["Faucet"])
app.include_router(stats.router, prefix="/api/stats", tags=["Stats"])


@app.get("/")
async def root():
    return {
        "protocol": "Trident Agent",
        "version": "1.0.0",
        "chain": "Arc Testnet",
        "chain_id": 5042002,
        "token": "$TRID",
        "status": "live",
    }


@app.get("/health")
async def health():
    return {"status": "healthy"}
