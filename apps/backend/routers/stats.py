"""
Stats and volume endpoints for the Trident dashboard.
"""
from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, func, cast, Date
from datetime import datetime, timedelta
import logging

from models.database import get_db, Payment, Agent, Service, ReputationEvent, JobStatus, AnomalyType

router = APIRouter()
logger = logging.getLogger(__name__)


@router.get("/overview")
async def get_overview(db: AsyncSession = Depends(get_db)):
    """Top-level stats for the dashboard hero section."""

    total_volume_result = await db.execute(
        select(func.sum(Payment.amount)).where(Payment.status != JobStatus.FAILED)
    )
    total_volume = total_volume_result.scalar() or 0

    tx_count_result = await db.execute(select(func.count(Payment.id)))
    tx_count = tx_count_result.scalar() or 0

    recovered_result = await db.execute(
        select(func.sum(Payment.retrobot_recovery_amount)).where(
            Payment.retrobot_recovery_amount.isnot(None)
        )
    )
    total_recovered = recovered_result.scalar() or 0

    flagged_result = await db.execute(
        select(func.count(Payment.id)).where(Payment.anomaly_flagged == True)
    )
    flagged_count = flagged_result.scalar() or 0

    agents_result = await db.execute(
        select(func.count(Agent.id)).where(Agent.active == True)
    )
    agent_count = agents_result.scalar() or 0

    services_result = await db.execute(
        select(func.count(Service.id)).where(Service.active == True)
    )
    service_count = services_result.scalar() or 0

    # 24h volume
    since_24h = datetime.utcnow() - timedelta(hours=24)
    vol_24h_result = await db.execute(
        select(func.sum(Payment.amount)).where(
            Payment.created_at >= since_24h,
            Payment.status != JobStatus.FAILED,
        )
    )
    vol_24h = vol_24h_result.scalar() or 0

    tx_24h_result = await db.execute(
        select(func.count(Payment.id)).where(Payment.created_at >= since_24h)
    )
    tx_24h = tx_24h_result.scalar() or 0

    return {
        "total_volume_trid": total_volume,
        "total_volume_display": f"{total_volume / 1e6:.2f} TRID",
        "total_transactions": tx_count,
        "total_recovered_trid": total_recovered,
        "total_recovered_display": f"{total_recovered / 1e6:.2f} TRID",
        "anomalies_caught": flagged_count,
        "active_agents": agent_count,
        "active_services": service_count,
        "volume_24h_trid": vol_24h,
        "volume_24h_display": f"{vol_24h / 1e6:.2f} TRID",
        "transactions_24h": tx_24h,
        "retrobot_recovery_rate": f"{(total_recovered / total_volume * 100):.1f}%" if total_volume > 0 else "0%",
    }


@router.get("/volume")
async def get_volume_chart(hours: int = 24, db: AsyncSession = Depends(get_db)):
    """Hourly volume buckets for the recharts line chart."""
    since = datetime.utcnow() - timedelta(hours=hours)

    result = await db.execute(
        select(Payment).where(
            Payment.created_at >= since,
            Payment.status != JobStatus.FAILED,
        ).order_by(Payment.created_at.asc())
    )
    payments = result.scalars().all()

    # Bucket into hourly slots
    buckets: dict = {}
    for p in payments:
        if p.created_at:
            hour_key = p.created_at.replace(minute=0, second=0, microsecond=0)
            slot = hour_key.isoformat()
            if slot not in buckets:
                buckets[slot] = {"time": slot, "volume": 0, "transactions": 0, "recovered": 0}
            buckets[slot]["volume"] += p.amount
            buckets[slot]["transactions"] += 1
            if p.retrobot_recovery_amount:
                buckets[slot]["recovered"] += p.retrobot_recovery_amount

    # Normalise to display units
    chart_data = []
    for slot, data in sorted(buckets.items()):
        chart_data.append({
            "time": slot,
            "volume": round(data["volume"] / 1e6, 4),
            "transactions": data["transactions"],
            "recovered": round(data["recovered"] / 1e6, 4),
        })

    return {"period_hours": hours, "data": chart_data}


@router.get("/retrobot")
async def get_retrobot_stats(db: AsyncSession = Depends(get_db)):
    """Retrobot-specific stats for the USP section."""
    anomalies_result = await db.execute(
        select(Payment).where(Payment.anomaly_flagged == True)
        .order_by(Payment.created_at.desc()).limit(10)
    )
    recent_anomalies = anomalies_result.scalars().all()

    total_scanned_result = await db.execute(select(func.count(Payment.id)))
    total_scanned = total_scanned_result.scalar() or 0

    total_recovered_result = await db.execute(
        select(func.sum(Payment.retrobot_recovery_amount)).where(
            Payment.retrobot_recovery_amount.isnot(None)
        )
    )
    total_recovered = total_recovered_result.scalar() or 0

    by_type_result = await db.execute(
        select(Payment.anomaly_type, func.count(Payment.id))
        .where(Payment.anomaly_flagged == True)
        .group_by(Payment.anomaly_type)
    )
    by_type = {row[0].value: row[1] for row in by_type_result.all() if row[0]}

    return {
        "total_scanned": total_scanned,
        "anomalies_caught": len(recent_anomalies),
        "total_recovered_trid": total_recovered,
        "total_recovered_display": f"{total_recovered / 1e6:.2f} TRID",
        "detection_rate": f"{(len(recent_anomalies) / max(total_scanned, 1)) * 100:.1f}%",
        "anomaly_breakdown": by_type,
        "recent_anomalies": [
            {
                "id": p.id,
                "buyer": p.buyer_address[:8] + "..." + p.buyer_address[-4:],
                "seller": p.seller_address[:8] + "..." + p.seller_address[-4:],
                "amount": f"{p.amount / 1e6:.4f} TRID",
                "type": p.anomaly_type.value if p.anomaly_type else "none",
                "reason": p.anomaly_reason,
                "recovered": f"{p.retrobot_recovery_amount / 1e6:.4f} TRID" if p.retrobot_recovery_amount else None,
                "status": p.status.value,
                "timestamp": p.created_at.isoformat() if p.created_at else None,
            }
            for p in recent_anomalies
        ],
    }
