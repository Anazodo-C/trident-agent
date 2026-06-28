from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, desc
from pydantic import BaseModel
from typing import Optional
import logging

from models.database import get_db, Agent, ReputationEvent
from config import get_settings

router = APIRouter()
logger = logging.getLogger(__name__)
settings = get_settings()


class BondRequest(BaseModel):
    wallet_address: str
    amount: int  # TRID in 6 decimals


@router.get("/leaderboard")
async def get_leaderboard(limit: int = 20, db: AsyncSession = Depends(get_db)):
    """Top agents by reputation score."""
    result = await db.execute(
        select(Agent)
        .where(Agent.active == True)
        .order_by(desc(Agent.reputation_score))
        .limit(limit)
    )
    agents = result.scalars().all()
    return {
        "leaderboard": [
            {
                "rank": i + 1,
                "wallet_address": a.wallet_address,
                "name": a.name,
                "agent_type": a.agent_type.value,
                "reputation_score": a.reputation_score,
                "reputation_pct": round(a.reputation_score / 100, 1),
                "total_jobs": a.total_jobs,
                "success_rate": round(a.successful_jobs / a.total_jobs * 100, 1) if a.total_jobs else 0,
                "total_earned": a.total_earned,
                "is_retrobot": a.is_retrobot,
            }
            for i, a in enumerate(agents)
        ]
    }


@router.get("/agent/{wallet_address}")
async def get_agent_reputation(wallet_address: str, db: AsyncSession = Depends(get_db)):
    """Reputation profile for a specific agent."""
    result = await db.execute(
        select(Agent).where(Agent.wallet_address == wallet_address.lower())
    )
    agent = result.scalar_one_or_none()
    if not agent:
        raise HTTPException(status_code=404, detail="Agent not found")

    events_result = await db.execute(
        select(ReputationEvent)
        .where(ReputationEvent.agent_address == wallet_address.lower())
        .order_by(desc(ReputationEvent.created_at))
        .limit(20)
    )
    events = events_result.scalars().all()

    return {
        "wallet_address": agent.wallet_address,
        "name": agent.name,
        "agent_type": agent.agent_type.value,
        "reputation_score": agent.reputation_score,
        "reputation_pct": round(agent.reputation_score / 100, 1),
        "reputation_tier": _get_tier(agent.reputation_score),
        "total_jobs": agent.total_jobs,
        "successful_jobs": agent.successful_jobs,
        "failed_jobs": agent.failed_jobs,
        "success_rate": round(agent.successful_jobs / agent.total_jobs * 100, 1) if agent.total_jobs else 0,
        "total_earned": agent.total_earned,
        "total_spent": agent.total_spent,
        "trid_balance": agent.trid_balance,
        "is_retrobot": agent.is_retrobot,
        "recent_events": [
            {
                "score_delta": e.score_delta,
                "reason": e.reason,
                "created_at": e.created_at.isoformat() if e.created_at else None,
            }
            for e in events
        ],
    }


@router.get("/stats")
async def get_reputation_stats(db: AsyncSession = Depends(get_db)):
    """Global reputation system stats."""
    from sqlalchemy import func
    total_agents = await db.scalar(select(func.count(Agent.id)).where(Agent.active == True))
    avg_score = await db.scalar(select(func.avg(Agent.reputation_score)).where(Agent.active == True))
    total_bonded = await db.scalar(select(func.sum(Agent.trid_balance)).where(Agent.active == True))

    return {
        "total_agents": total_agents or 0,
        "average_reputation": round(float(avg_score or 5000), 1),
        "total_trid_bonded": total_bonded or 0,
        "tiers": {
            "elite": "8000-10000 bp",
            "premium": "6000-7999 bp",
            "verified": "4000-5999 bp",
            "basic": "2000-3999 bp",
            "probation": "0-1999 bp",
        },
    }


def _get_tier(score: int) -> str:
    if score >= 8000: return "Elite"
    if score >= 6000: return "Premium"
    if score >= 4000: return "Verified"
    if score >= 2000: return "Basic"
    return "Probation"
