from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from pydantic import BaseModel
from typing import Optional, List
import logging

from models.database import get_db, Agent, AgentType
from config import get_settings

router = APIRouter()
logger = logging.getLogger(__name__)
settings = get_settings()


class RegisterAgentRequest(BaseModel):
    wallet_address: str
    name: str
    description: Optional[str] = None
    agent_type: str  # buyer | seller | both | retrobot
    service_endpoint: Optional[str] = None
    service_types: Optional[List[str]] = None


class UpdateAgentRequest(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    service_endpoint: Optional[str] = None
    service_types: Optional[List[str]] = None


@router.post("/register")
async def register_agent(request: RegisterAgentRequest, db: AsyncSession = Depends(get_db)):
    existing = await db.execute(
        select(Agent).where(Agent.wallet_address == request.wallet_address.lower())
    )
    if existing.scalar_one_or_none():
        raise HTTPException(status_code=409, detail="Agent already registered")

    try:
        agent_type = AgentType(request.agent_type.lower())
    except ValueError:
        raise HTTPException(status_code=400, detail=f"Invalid agent type: {request.agent_type}")

    import json
    agent = Agent(
        wallet_address=request.wallet_address.lower(),
        name=request.name,
        description=request.description,
        agent_type=agent_type,
        service_endpoint=request.service_endpoint,
        service_types=json.dumps(request.service_types or []),
        is_retrobot=(agent_type == AgentType.RETROBOT),
    )
    db.add(agent)
    await db.commit()
    await db.refresh(agent)

    logger.info(f"Agent registered: {request.wallet_address} ({agent_type.value})")
    return {
        "agent_id": agent.id,
        "wallet_address": agent.wallet_address,
        "name": agent.name,
        "agent_type": agent.agent_type.value,
        "reputation_score": agent.reputation_score,
        "status": "registered",
    }


@router.get("/{wallet_address}")
async def get_agent(wallet_address: str, db: AsyncSession = Depends(get_db)):
    result = await db.execute(
        select(Agent).where(Agent.wallet_address == wallet_address.lower())
    )
    agent = result.scalar_one_or_none()
    if not agent:
        raise HTTPException(status_code=404, detail="Agent not found")

    import json
    return {
        "id": agent.id,
        "wallet_address": agent.wallet_address,
        "name": agent.name,
        "description": agent.description,
        "agent_type": agent.agent_type.value,
        "service_endpoint": agent.service_endpoint,
        "service_types": json.loads(agent.service_types or "[]"),
        "reputation_score": agent.reputation_score,
        "total_jobs": agent.total_jobs,
        "successful_jobs": agent.successful_jobs,
        "trid_balance": agent.trid_balance,
        "circle_wallet_id": agent.circle_wallet_id,
        "is_retrobot": agent.is_retrobot,
        "active": agent.active,
        "created_at": agent.created_at.isoformat() if agent.created_at else None,
    }


@router.get("/")
async def list_agents(
    agent_type: Optional[str] = None,
    limit: int = 50,
    db: AsyncSession = Depends(get_db),
):
    query = select(Agent).where(Agent.active == True)
    if agent_type:
        try:
            query = query.where(Agent.agent_type == AgentType(agent_type.lower()))
        except ValueError:
            pass
    query = query.order_by(Agent.reputation_score.desc()).limit(limit)
    result = await db.execute(query)
    agents = result.scalars().all()

    import json
    return {
        "agents": [
            {
                "wallet_address": a.wallet_address,
                "name": a.name,
                "agent_type": a.agent_type.value,
                "reputation_score": a.reputation_score,
                "service_types": json.loads(a.service_types or "[]"),
                "is_retrobot": a.is_retrobot,
            }
            for a in agents
        ],
        "total": len(agents),
    }


@router.patch("/{wallet_address}")
async def update_agent(
    wallet_address: str,
    request: UpdateAgentRequest,
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(Agent).where(Agent.wallet_address == wallet_address.lower())
    )
    agent = result.scalar_one_or_none()
    if not agent:
        raise HTTPException(status_code=404, detail="Agent not found")

    import json
    if request.name is not None: agent.name = request.name
    if request.description is not None: agent.description = request.description
    if request.service_endpoint is not None: agent.service_endpoint = request.service_endpoint
    if request.service_types is not None: agent.service_types = json.dumps(request.service_types)

    await db.commit()
    return {"status": "updated", "wallet_address": wallet_address}
