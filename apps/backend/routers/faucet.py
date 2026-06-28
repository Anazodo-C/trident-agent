from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from pydantic import BaseModel
import logging

from models.database import get_db, Agent
from config import get_settings

router = APIRouter()
logger = logging.getLogger(__name__)
settings = get_settings()

FAUCET_AMOUNT = 10 * 1_000_000  # 10 TRID in 6 decimals


class FaucetRequest(BaseModel):
    wallet_address: str


@router.post("/claim")
async def claim_faucet(request: FaucetRequest, db: AsyncSession = Depends(get_db)):
    """
    Bootstrap endpoint — directs agents to the TridentFaucet contract.
    Actual claim happens on-chain; this records intent and provides calldata.
    """
    result = await db.execute(
        select(Agent).where(Agent.wallet_address == request.wallet_address.lower())
    )
    agent = result.scalar_one_or_none()

    return {
        "wallet_address": request.wallet_address,
        "faucet_contract": settings.trident_faucet_address,
        "claim_amount": FAUCET_AMOUNT,
        "claim_amount_display": "10 TRID",
        "instructions": [
            "1. Call TridentFaucet.claim() on Arc Testnet",
            f"   Contract: {settings.trident_faucet_address}",
            "2. Cooldown: 1 hour between claims",
            "3. TRID is minted 1:1 — use it to buy marketplace services",
        ],
        "agent_registered": agent is not None,
        "arc_explorer": f"https://testnet.arcscan.app/address/{settings.trident_faucet_address}",
    }


@router.get("/status/{wallet_address}")
async def faucet_status(wallet_address: str):
    """Check if a wallet can claim from the faucet."""
    return {
        "wallet_address": wallet_address,
        "faucet_contract": settings.trident_faucet_address,
        "claim_amount": FAUCET_AMOUNT,
        "note": "Call canClaim(address) on the TridentFaucet contract for live eligibility status",
        "arc_explorer": f"https://testnet.arcscan.app/address/{settings.trident_faucet_address}",
    }
