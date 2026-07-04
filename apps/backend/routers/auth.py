"""
Auth router — Google OAuth (ID token verify) + wallet sign-in (EIP-191) + JWT sessions.

Flow:
  Web2:  Frontend gets Google ID token via @react-oauth/google
         → POST /auth/google { id_token } → verify via Google tokeninfo API
         → create/find User → return JWT

  Web3:  GET /auth/nonce?address=0x...
         → sign nonce with MetaMask (personal_sign / EIP-191)
         → POST /auth/wallet { address, signature } → verify → create/find User → return JWT

  Both:  If user has no agent yet, frontend calls POST /auth/create-agent (Node backend)
         then PUT /auth/me/agent { agent_address } to register it here.
"""
import time
import logging
import secrets
import hashlib
from datetime import datetime, timedelta, timezone

import httpx
from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from jose import JWTError, jwt
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from web3 import Web3
from eth_account.messages import encode_defunct

from models.database import get_db, User, Agent, AgentType
from config import get_settings

router   = APIRouter()
logger   = logging.getLogger(__name__)
settings = get_settings()
bearer   = HTTPBearer(auto_error=False)

# ── JWT config ────────────────────────────────────────────────────────────────
JWT_SECRET    = getattr(settings, "jwt_secret", None) or "trident-jwt-secret-change-in-prod"
JWT_ALGORITHM = "HS256"
JWT_EXPIRE_DAYS = 7

# In-memory nonce store (sufficient for hackathon; use Redis in production)
_nonces: dict[str, tuple[str, float]] = {}  # address → (nonce, expires_at)
NONCE_TTL = 300  # 5 minutes

# ── Helpers ───────────────────────────────────────────────────────────────────

def create_jwt(user_id: int, email: str | None, wallet: str | None) -> str:
    payload = {
        "sub": str(user_id),
        "email": email,
        "wallet": wallet,
        "exp": datetime.now(timezone.utc) + timedelta(days=JWT_EXPIRE_DAYS),
        "iat": datetime.now(timezone.utc),
    }
    return jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALGORITHM)


def decode_jwt(token: str) -> dict:
    try:
        return jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGORITHM])
    except JWTError as e:
        raise HTTPException(status_code=401, detail=f"Invalid token: {e}")


async def get_current_user(
    creds: HTTPAuthorizationCredentials | None = Depends(bearer),
    db: AsyncSession = Depends(get_db),
) -> User:
    if not creds:
        raise HTTPException(status_code=401, detail="Authorization header missing")
    payload = decode_jwt(creds.credentials)
    result = await db.execute(select(User).where(User.id == int(payload["sub"])))
    user = result.scalar_one_or_none()
    if not user:
        raise HTTPException(status_code=401, detail="User not found")
    return user


async def _ensure_agent_in_db(db: AsyncSession, user: User):
    """Mirror user's agent into the agents table so it appears on the marketplace."""
    if not user.agent_address:
        return
    result = await db.execute(
        select(Agent).where(Agent.wallet_address == user.agent_address.lower())
    )
    if not result.scalar_one_or_none():
        db.add(Agent(
            wallet_address=user.agent_address.lower(),
            name=f"{user.name or user.email or 'User'}'s Agent",
            agent_type=AgentType.BUYER,
            reputation_score=5000,
            trid_balance=0,
        ))
        await db.commit()


# ── Schemas ───────────────────────────────────────────────────────────────────

class GoogleAuthRequest(BaseModel):
    id_token: str

class WalletAuthRequest(BaseModel):
    address: str
    signature: str

class RegisterAgentRequest(BaseModel):
    agent_address: str

class BudgetRequest(BaseModel):
    max_trid_budget: int  # micro-TRID

# ── Routes ────────────────────────────────────────────────────────────────────

@router.post("/google")
async def auth_google(body: GoogleAuthRequest, db: AsyncSession = Depends(get_db)):
    """Verify Google ID token and return a Trident JWT."""
    async with httpx.AsyncClient() as client:
        r = await client.get(
            "https://oauth2.googleapis.com/tokeninfo",
            params={"id_token": body.id_token},
            timeout=10,
        )
    if r.status_code != 200:
        raise HTTPException(status_code=401, detail="Invalid Google ID token")

    info = r.json()
    google_id = info.get("sub")
    email     = info.get("email")
    name      = info.get("name")
    avatar    = info.get("picture")

    if not google_id:
        raise HTTPException(status_code=401, detail="Google token missing sub")

    # Find or create user
    result = await db.execute(select(User).where(User.google_id == google_id))
    user = result.scalar_one_or_none()

    if not user and email:
        # Also check if they signed up by email earlier
        result2 = await db.execute(select(User).where(User.email == email))
        user = result2.scalar_one_or_none()

    if user:
        # Update profile fields
        user.google_id  = google_id
        user.name       = user.name or name
        user.avatar_url = user.avatar_url or avatar
    else:
        user = User(google_id=google_id, email=email, name=name, avatar_url=avatar)
        db.add(user)

    await db.commit()
    await db.refresh(user)

    token = create_jwt(user.id, user.email, user.wallet_address)
    return {
        "token": token,
        "user": {
            "id": user.id,
            "email": user.email,
            "name": user.name,
            "avatar_url": user.avatar_url,
            "agent_address": user.agent_address,
            "agent_created": user.agent_created,
            "max_trid_budget": user.max_trid_budget,
        },
    }


@router.get("/nonce")
async def get_nonce(address: str):
    """Return a one-time nonce the wallet must sign to authenticate."""
    addr = address.lower()
    nonce = secrets.token_hex(16)
    _nonces[addr] = (nonce, time.time() + NONCE_TTL)
    return {
        "nonce": nonce,
        "message": f"Sign in to Trident Agent\nAddress: {address}\nNonce: {nonce}",
    }


@router.post("/wallet")
async def auth_wallet(body: WalletAuthRequest, db: AsyncSession = Depends(get_db)):
    """Verify EIP-191 wallet signature and return a Trident JWT."""
    addr = body.address.lower()
    entry = _nonces.get(addr)
    if not entry:
        raise HTTPException(status_code=400, detail="No nonce found — call GET /auth/nonce first")
    nonce, expires = entry
    if time.time() > expires:
        del _nonces[addr]
        raise HTTPException(status_code=400, detail="Nonce expired")

    message = f"Sign in to Trident Agent\nAddress: {body.address}\nNonce: {nonce}"
    try:
        w3 = Web3()
        msg = encode_defunct(text=message)
        recovered = w3.eth.account.recover_message(msg, signature=body.signature)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Signature verification failed: {e}")

    if recovered.lower() != addr:
        raise HTTPException(status_code=401, detail="Signature does not match address")

    del _nonces[addr]  # consume nonce

    result = await db.execute(select(User).where(User.wallet_address == addr))
    user = result.scalar_one_or_none()
    if not user:
        user = User(wallet_address=addr, name=f"Agent {addr[:6]}…{addr[-4:]}")
        db.add(user)
        await db.commit()
        await db.refresh(user)

    token = create_jwt(user.id, user.email, user.wallet_address)
    return {
        "token": token,
        "user": {
            "id": user.id,
            "email": user.email,
            "name": user.name,
            "wallet_address": user.wallet_address,
            "agent_address": user.agent_address,
            "agent_created": user.agent_created,
            "max_trid_budget": user.max_trid_budget,
        },
    }


@router.get("/me")
async def get_me(user: User = Depends(get_current_user)):
    return {
        "id": user.id,
        "email": user.email,
        "name": user.name,
        "avatar_url": user.avatar_url,
        "wallet_address": user.wallet_address,
        "agent_address": user.agent_address,
        "agent_created": user.agent_created,
        "max_trid_budget": user.max_trid_budget,
        "trid_spent": user.trid_spent,
        "budget_remaining": max(0, (user.max_trid_budget or 0) - (user.trid_spent or 0)),
    }


@router.put("/me/agent")
async def register_agent(
    body: RegisterAgentRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Called by frontend after showing the one-time key — registers agent address."""
    if user.agent_created:
        raise HTTPException(status_code=400, detail="Agent already registered for this account")

    user.agent_address = body.agent_address.lower()
    user.agent_created = True
    await db.commit()
    await _ensure_agent_in_db(db, user)

    return {
        "agent_address": user.agent_address,
        "message": "Agent registered — private key is your responsibility",
    }


@router.put("/me/budget")
async def set_budget(
    body: BudgetRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Set or update user's maximum TRID spend budget."""
    if body.max_trid_budget < 0:
        raise HTTPException(status_code=400, detail="Budget cannot be negative")
    user.max_trid_budget = body.max_trid_budget
    await db.commit()
    return {
        "max_trid_budget": user.max_trid_budget,
        "max_trid_budget_display": f"{user.max_trid_budget / 1_000_000:.4f} TRID",
    }
