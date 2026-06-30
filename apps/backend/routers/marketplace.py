from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from pydantic import BaseModel
from typing import Optional
import logging

from models.database import get_db, Service, Agent, Payment, JobStatus
from services.financial_data import FinancialDataService
from config import get_settings

router = APIRouter()
logger = logging.getLogger(__name__)
settings = get_settings()


class ServiceListing(BaseModel):
    service_type: str
    name: str
    description: str
    price_per_call: int
    endpoint: str


@router.get("/services")
async def list_services(
    service_type: Optional[str] = None,
    min_reputation: Optional[int] = None,
    db: AsyncSession = Depends(get_db),
):
    query = select(Service).where(Service.active == True)
    if service_type:
        query = query.where(Service.service_type == service_type)
    query = query.order_by(Service.calls_served.desc())

    result = await db.execute(query)
    services = result.scalars().all()

    enriched = []
    for svc in services:
        agent_result = await db.execute(
            select(Agent).where(Agent.wallet_address == svc.seller_address)
        )
        agent = agent_result.scalar_one_or_none()
        if min_reputation and agent and agent.reputation_score < min_reputation:
            continue
        enriched.append({
            "id": svc.id,
            "seller_address": svc.seller_address,
            "service_type": svc.service_type,
            "name": svc.name,
            "description": svc.description,
            "price_per_call": svc.price_per_call,
            "price_trid_display": f"{svc.price_per_call / 1e6:.4f} TRID",
            "endpoint": svc.endpoint,
            "x402_enabled": svc.x402_enabled,
            "calls_served": svc.calls_served,
            "seller_reputation": agent.reputation_score if agent else 5000,
            "seller_name": agent.name if agent else "Unknown Agent",
        })

    return {"services": enriched, "total": len(enriched)}


@router.post("/services/register")
async def register_service(
    listing: ServiceListing,
    wallet_address: str,
    db: AsyncSession = Depends(get_db),
):
    agent_result = await db.execute(
        select(Agent).where(Agent.wallet_address == wallet_address.lower())
    )
    agent = agent_result.scalar_one_or_none()
    if not agent:
        raise HTTPException(status_code=404, detail="Agent not registered")

    service = Service(
        seller_address=wallet_address.lower(),
        service_type=listing.service_type,
        name=listing.name,
        description=listing.description,
        price_per_call=listing.price_per_call,
        endpoint=listing.endpoint,
        x402_enabled=True,
    )
    db.add(service)
    await db.commit()
    await db.refresh(service)
    return {"service_id": service.id, "status": "registered"}


@router.get("/data/price-feed")
async def get_price_feed(symbols: str = "BTC,ETH,USDC", db: AsyncSession = Depends(get_db)):
    fin = FinancialDataService()
    symbol_list = [s.strip().upper() for s in symbols.split(",")]
    data = await fin.get_price_feed(symbol_list)
    return {"service": "price_feed", "provider": "Trident / CoinGecko", "data": data, "price_paid": "0.001 TRID"}


@router.get("/data/fx-rates")
async def get_fx_rates(base: str = "USD", targets: str = "EUR,GBP,NGN,JPY,BRL,GHS"):
    fin = FinancialDataService()
    target_list = [t.strip().upper() for t in targets.split(",")]
    # Returns flat {EUR: 0.9214, GBP: 0.7891, ...}
    flat_rates = await fin.get_fx_rates(base, target_list)
    return {"service": "fx_rates", "provider": "Trident / exchangerate.host", "base": base, "data": flat_rates, "price_paid": "0.001 TRID"}


@router.get("/data/risk-score")
async def get_risk_score(address: str):
    fin = FinancialDataService()
    data = await fin.get_risk_score(address)
    return {"service": "risk_score", "provider": "Trident / Messari", "address": address, "data": data, "price_paid": "0.005 TRID"}


@router.get("/data/research-summary")
async def get_research_summary(asset: str = "BTC"):
    fin = FinancialDataService()
    data = await fin.get_research_summary(asset)
    return {"service": "research_summary", "provider": "Trident / Claude", "asset": asset, "data": data, "price_paid": "0.01 TRID"}


@router.get("/data/compute-score")
async def get_compute_score(portfolio: str, model: str = "sharpe"):
    fin = FinancialDataService()
    data = await fin.get_compute_score(portfolio, model)
    return {"service": "compute_score", "provider": "Trident", "model": model, "data": data, "price_paid": "0.02 TRID"}


@router.get("/activity/live")
async def get_live_activity(limit: int = 20, db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(Payment).order_by(Payment.created_at.desc()).limit(limit))
    payments = result.scalars().all()
    return {
        "activity": [
            {
                "id": p.id,
                "buyer": p.buyer_address[:6] + "..." + p.buyer_address[-4:],
                "seller": p.seller_address[:6] + "..." + p.seller_address[-4:],
                "amount": p.amount,
                "amount_display": f"{p.amount / 1e6:.4f} TRID",
                "service_type": p.service_type,
                "status": p.status.value,
                "anomaly_flagged": p.anomaly_flagged,
                "created_at": p.created_at.isoformat() if p.created_at else None,
            }
            for p in payments
        ]
    }
