from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from anthropic import AsyncAnthropic
from datetime import datetime, timedelta
import logging
import json

from models.database import Payment, Agent, AnomalyType, JobStatus
from config import get_settings

logger = logging.getLogger(__name__)
settings = get_settings()

OVERPAYMENT_THRESHOLD_BPS = 1100  # flag if paid > 110% of last known price
DUPLICATE_WINDOW_SECONDS = 300    # 5 minutes
FAILED_DELIVERY_TIMEOUT = 3600    # 1 hour


class RetrobotEngine:
    def __init__(self, db: AsyncSession):
        self.db = db
        self.claude = AsyncAnthropic(api_key=settings.anthropic_api_key)

    async def scan_payment(
        self,
        payment_id: int,
        buyer_address: str,
        seller_address: str,
        amount: int,
        service_type: str,
        job_hash: str | None = None,
    ) -> dict:
        results = {
            "payment_id": payment_id,
            "anomaly_detected": False,
            "anomaly_type": AnomalyType.NONE.value,
            "confidence": 0.0,
            "reason": None,
            "recommended_action": "proceed",
            "checks": {},
        }

        overpay = await self._check_overpayment(buyer_address, seller_address, amount, service_type)
        results["checks"]["overpayment"] = overpay

        duplicate = await self._check_duplicate(buyer_address, seller_address, amount, service_type, job_hash)
        results["checks"]["duplicate"] = duplicate

        delivery_risk = await self._check_delivery_risk(seller_address, service_type)
        results["checks"]["delivery_risk"] = delivery_risk

        if duplicate["detected"]:
            results.update(anomaly_detected=True, anomaly_type=AnomalyType.DUPLICATE.value,
                           confidence=duplicate["confidence"], reason=duplicate["reason"],
                           recommended_action="block_and_refund")
        elif overpay["detected"]:
            results.update(anomaly_detected=True, anomaly_type=AnomalyType.OVERPAYMENT.value,
                           confidence=overpay["confidence"], reason=overpay["reason"],
                           recommended_action="flag_for_review")
        elif delivery_risk["high_risk"]:
            results.update(anomaly_detected=True, anomaly_type=AnomalyType.FAILED_DELIVERY.value,
                           confidence=delivery_risk["confidence"], reason=delivery_risk["reason"],
                           recommended_action="monitor_closely")

        if results["anomaly_detected"] and results["confidence"] < 0.7:
            claude_verdict = await self._claude_reasoning(results, amount, service_type)
            results["claude_reasoning"] = claude_verdict
            results["confidence"] = claude_verdict.get("adjusted_confidence", results["confidence"])

        if results["anomaly_detected"]:
            await self._flag_payment_in_db(payment_id, results["anomaly_type"], results["reason"])

        return results

    async def _check_overpayment(self, buyer: str, seller: str, amount: int, service_type: str) -> dict:
        recent = await self.db.execute(
            select(Payment)
            .where(Payment.seller_address == seller.lower(), Payment.service_type == service_type,
                   Payment.status == JobStatus.COMPLETED)
            .order_by(Payment.created_at.desc()).limit(10)
        )
        recent_payments = recent.scalars().all()

        if not recent_payments:
            return {"detected": False, "reason": "No price history", "confidence": 0.0}

        avg_amount = sum(p.amount for p in recent_payments) / len(recent_payments)
        ratio = amount / avg_amount if avg_amount > 0 else 1.0
        threshold = OVERPAYMENT_THRESHOLD_BPS / 1000

        if ratio > threshold:
            overpay_pct = round((ratio - 1) * 100, 1)
            return {
                "detected": True,
                "reason": f"Payment is {overpay_pct}% above average price for {service_type}",
                "confidence": min(0.95, 0.5 + (ratio - threshold) * 0.5),
                "expected_amount": int(avg_amount),
                "actual_amount": amount,
                "overpay_ratio": round(ratio, 3),
            }
        return {"detected": False, "confidence": 0.0}

    async def _check_duplicate(self, buyer: str, seller: str, amount: int, service_type: str, job_hash: str | None) -> dict:
        window_start = datetime.utcnow() - timedelta(seconds=DUPLICATE_WINDOW_SECONDS)

        if job_hash:
            existing = await self.db.execute(
                select(Payment).where(Payment.job_hash == job_hash, Payment.status != JobStatus.FAILED)
            )
            match = existing.scalar_one_or_none()
            if match:
                return {"detected": True, "reason": f"Identical job hash — payment ID {match.id} exists",
                        "confidence": 0.99, "original_payment_id": match.id}

        fuzzy = await self.db.execute(
            select(Payment).where(
                Payment.buyer_address == buyer.lower(), Payment.seller_address == seller.lower(),
                Payment.amount == amount, Payment.service_type == service_type,
                Payment.created_at >= window_start, Payment.status != JobStatus.FAILED,
            )
        )
        match = fuzzy.scalar_one_or_none()
        if match:
            return {"detected": True, "reason": f"Identical payment made within {DUPLICATE_WINDOW_SECONDS//60} minutes",
                    "confidence": 0.85, "original_payment_id": match.id}

        return {"detected": False, "confidence": 0.0}

    async def _check_delivery_risk(self, seller: str, service_type: str) -> dict:
        agent_result = await self.db.execute(select(Agent).where(Agent.wallet_address == seller.lower()))
        agent = agent_result.scalar_one_or_none()

        if not agent:
            return {"high_risk": True, "reason": "Seller not registered — unverified agent", "confidence": 0.6}

        if agent.total_jobs > 0:
            failure_rate = agent.failed_jobs / agent.total_jobs
            if failure_rate > 0.3:
                return {"high_risk": True, "confidence": min(0.9, failure_rate + 0.3),
                        "reason": f"Seller has {round(failure_rate*100)}% failure rate ({agent.failed_jobs}/{agent.total_jobs} jobs)"}

        if agent.reputation_score < 2000:
            return {"high_risk": True, "confidence": 0.75,
                    "reason": f"Seller reputation critically low: {agent.reputation_score}/10000"}

        return {"high_risk": False, "confidence": 0.0}

    async def _claude_reasoning(self, scan_result: dict, amount: int, service_type: str) -> dict:
        try:
            prompt = f"""You are Retrobot, Trident's autonomous payment recovery agent on Arc blockchain.

Analyse this anomaly case and give your verdict:

Payment Amount: {amount / 1e6:.6f} TRID
Service Type: {service_type}
Anomaly Detected: {scan_result['anomaly_type']}
Initial Confidence: {scan_result['confidence']}
Reason: {scan_result['reason']}

Checks:
{json.dumps(scan_result['checks'], indent=2)}

Respond in JSON only:
{{
  "verdict": "confirmed_anomaly" | "false_positive" | "monitor",
  "adjusted_confidence": <float 0.0-1.0>,
  "reasoning": "<one sentence>",
  "recommended_action": "block_and_refund" | "flag_for_review" | "proceed" | "monitor_closely"
}}"""

            response = await self.claude.messages.create(
                model="claude-sonnet-4-6",
                max_tokens=300,
                messages=[{"role": "user", "content": prompt}],
            )
            return json.loads(response.content[0].text.strip())
        except Exception as e:
            logger.error(f"Claude reasoning failed: {e}")
            return {"verdict": "monitor", "adjusted_confidence": scan_result["confidence"],
                    "reasoning": "Claude unavailable — maintaining initial assessment",
                    "recommended_action": scan_result["recommended_action"]}

    async def _flag_payment_in_db(self, payment_id: int, anomaly_type: str, reason: str) -> None:
        payment = await self.db.get(Payment, payment_id)
        if payment:
            payment.anomaly_flagged = True
            payment.anomaly_type = AnomalyType(anomaly_type)
            payment.anomaly_reason = reason
            payment.status = JobStatus.DISPUTED
            await self.db.commit()

    async def execute_recovery(self, payment_id: int) -> dict:
        from arc.contracts import TridentEscrowClient

        payment = await self.db.get(Payment, payment_id)
        if not payment or not payment.anomaly_flagged:
            return {"success": False, "reason": "Payment not eligible for recovery"}

        try:
            escrow_client = TridentEscrowClient()
            tx_hash = await escrow_client.execute_recovery(
                job_id=payment.job_id_onchain,
                recipient=payment.buyer_address,
                amount=payment.amount,
                reason=payment.anomaly_reason,
            )
            payment.status = JobStatus.RECOVERED
            payment.retrobot_recovery_amount = payment.amount
            await self.db.commit()
            logger.info(f"Recovery executed for payment {payment_id}: {tx_hash}")
            return {"success": True, "tx_hash": tx_hash, "amount_recovered": payment.amount}
        except Exception as e:
            logger.error(f"Recovery failed for payment {payment_id}: {e}")
            return {"success": False, "reason": str(e)}

    async def full_audit(self, wallet_address: str, lookback_hours: int = 24) -> dict:
        cutoff = datetime.utcnow() - timedelta(hours=lookback_hours)
        payments_result = await self.db.execute(
            select(Payment).where(
                (Payment.buyer_address == wallet_address.lower()) |
                (Payment.seller_address == wallet_address.lower()),
                Payment.created_at >= cutoff,
            ).order_by(Payment.created_at.desc())
        )
        payments = payments_result.scalars().all()

        anomalies = [p for p in payments if p.anomaly_flagged]
        recovered = [p for p in payments if p.status == JobStatus.RECOVERED]
        total_recovered = sum(p.retrobot_recovery_amount or 0 for p in recovered)

        return {
            "wallet": wallet_address,
            "lookback_hours": lookback_hours,
            "total_payments": len(payments),
            "anomalies_found": len(anomalies),
            "recoveries_executed": len(recovered),
            "total_trid_recovered": total_recovered,
            "anomaly_breakdown": {
                "overpayments": len([a for a in anomalies if a.anomaly_type == AnomalyType.OVERPAYMENT]),
                "duplicates": len([a for a in anomalies if a.anomaly_type == AnomalyType.DUPLICATE]),
                "failed_deliveries": len([a for a in anomalies if a.anomaly_type == AnomalyType.FAILED_DELIVERY]),
            },
            "payments": [
                {"id": p.id, "amount": p.amount, "service_type": p.service_type,
                 "status": p.status.value, "anomaly": p.anomaly_type.value if p.anomaly_flagged else None,
                 "created_at": p.created_at.isoformat() if p.created_at else None}
                for p in payments
            ],
        }
