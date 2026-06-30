from fastapi import APIRouter, Depends, HTTPException, BackgroundTasks
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, func
from pydantic import BaseModel
from typing import Optional
import logging

from models.database import get_db, Payment, Agent, AnomalyType, JobStatus
from services.retrobot_engine import RetrobotEngine
from config import get_settings

router = APIRouter()
logger = logging.getLogger(__name__)
settings = get_settings()


class AuditRequest(BaseModel):
    wallet_address: str
    lookback_hours: Optional[int] = 24


class ScanRequest(BaseModel):
    payment_id: int
    buyer_address: str
    seller_address: str
    amount: int
    service_type: str
    job_hash: Optional[str] = None


class RecoveryRequest(BaseModel):
    payment_id: int
    requester_address: str


@router.post("/audit")
async def audit_payment_history(request: AuditRequest, db: AsyncSession = Depends(get_db)):
    engine = RetrobotEngine(db)
    return await engine.full_audit(wallet_address=request.wallet_address, lookback_hours=request.lookback_hours)


@router.post("/scan")
async def scan_payment(request: ScanRequest, db: AsyncSession = Depends(get_db)):
    engine = RetrobotEngine(db)
    return await engine.scan_payment(
        payment_id=request.payment_id,
        buyer_address=request.buyer_address,
        seller_address=request.seller_address,
        amount=request.amount,
        service_type=request.service_type,
        job_hash=request.job_hash,
    )


@router.post("/recover")
async def initiate_recovery(
    request: RecoveryRequest,
    background_tasks: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
):
    payment = await db.get(Payment, request.payment_id)
    if not payment:
        raise HTTPException(status_code=404, detail="Payment not found")
    if not payment.anomaly_flagged:
        raise HTTPException(status_code=400, detail="Payment not flagged for recovery")
    if payment.buyer_address.lower() != request.requester_address.lower():
        raise HTTPException(status_code=403, detail="Only the buyer can initiate recovery")

    engine = RetrobotEngine(db)
    background_tasks.add_task(engine.execute_recovery, payment.id)
    return {
        "status": "recovery_initiated",
        "payment_id": request.payment_id,
        "anomaly_type": payment.anomaly_type.value,
        "message": "Retrobot is investigating. Recovery will execute automatically if confirmed.",
    }


@router.get("/anomalies")
async def get_anomalies(
    wallet_address: Optional[str] = None,
    limit: int = 50,
    db: AsyncSession = Depends(get_db),
):
    query = select(Payment).where(Payment.anomaly_flagged == True)
    if wallet_address:
        query = query.where(
            (Payment.buyer_address == wallet_address.lower()) |
            (Payment.seller_address == wallet_address.lower())
        )
    query = query.order_by(Payment.created_at.desc()).limit(limit)
    result = await db.execute(query)
    payments = result.scalars().all()

    return {
        "anomalies": [
            {
                "id": p.id,
                "buyer": p.buyer_address,
                "seller": p.seller_address,
                "amount": p.amount,
                "service_type": p.service_type,
                "anomaly_type": p.anomaly_type.value,
                "reason": p.anomaly_reason,
                "status": p.status.value,
                "recovery_amount": p.retrobot_recovery_amount,
                "created_at": p.created_at.isoformat() if p.created_at else None,
            }
            for p in payments
        ],
        "total": len(payments),
    }


@router.get("/stats")
async def get_retrobot_stats(db: AsyncSession = Depends(get_db)):
    total_scanned = await db.scalar(select(func.count(Payment.id)))
    total_flagged = await db.scalar(
        select(func.count(Payment.id)).where(Payment.anomaly_flagged == True)
    )
    total_recovered = await db.scalar(
        select(func.sum(Payment.retrobot_recovery_amount)).where(
            Payment.status == JobStatus.RECOVERED
        )
    )
    recovered_trid = float(total_recovered or 0)
    rate = round((total_flagged / total_scanned * 100), 2) if total_scanned else 0
    payload = {
        "total_scanned":           total_scanned or 0,
        "anomalies_caught":        total_flagged or 0,
        "total_recovered":         recovered_trid,
        "total_recovered_display": f"{recovered_trid / 1_000_000:.4f} TRID",
        "detection_rate":          f"{rate}%",
        "status":                  "guardian_active",
    }
    return {
        "service": "retrobot_audit",
        "data":    payload,
    }
