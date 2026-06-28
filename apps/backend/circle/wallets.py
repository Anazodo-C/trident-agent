"""
Circle Wallets SDK wrapper for Trident Agent.
Manages programmable wallets for agents on Arc Testnet.
"""
import httpx
import hashlib
import hmac
import json
import uuid
import logging
from config import get_settings

logger = logging.getLogger(__name__)
settings = get_settings()

CIRCLE_BASE_URL = "https://api.circle.com/v1/w3s"
CIRCLE_TESTNET_URL = "https://api-sandbox.circle.com/v1/w3s"


def _get_base_url() -> str:
    return CIRCLE_TESTNET_URL if settings.circle_environment == "testnet" else CIRCLE_BASE_URL


def _headers() -> dict:
    return {
        "Authorization": f"Bearer {settings.circle_api_key}",
        "Content-Type": "application/json",
    }


class CircleWalletClient:
    def __init__(self):
        self.base_url = _get_base_url()

    async def create_wallet(self, agent_name: str) -> dict:
        """Create a programmable wallet for an agent."""
        idempotency_key = str(uuid.uuid4())
        async with httpx.AsyncClient() as client:
            r = await client.post(
                f"{self.base_url}/wallets",
                headers=_headers(),
                json={
                    "idempotencyKey": idempotency_key,
                    "walletSetId": settings.circle_wallet_set_id,
                    "blockchains": ["MATIC-AMOY"],  # Closest to Arc for testnet
                    "count": 1,
                    "metadata": [{"name": agent_name, "refId": idempotency_key}],
                },
                timeout=30,
            )
            r.raise_for_status()
            data = r.json()
            wallets = data.get("data", {}).get("wallets", [])
            return wallets[0] if wallets else {}

    async def get_wallet_balance(self, wallet_id: str) -> dict:
        """Get token balances for a Circle wallet."""
        async with httpx.AsyncClient() as client:
            r = await client.get(
                f"{self.base_url}/wallets/{wallet_id}/balances",
                headers=_headers(),
                timeout=15,
            )
            r.raise_for_status()
            return r.json().get("data", {})

    async def initiate_transfer(
        self,
        wallet_id: str,
        destination_address: str,
        amount: str,
        token_id: str,
    ) -> dict:
        """Initiate a USDC transfer from a Circle wallet."""
        async with httpx.AsyncClient() as client:
            r = await client.post(
                f"{self.base_url}/user/transactions/transfer",
                headers=_headers(),
                json={
                    "idempotencyKey": str(uuid.uuid4()),
                    "walletId": wallet_id,
                    "destinationAddress": destination_address,
                    "amounts": [amount],
                    "tokenId": token_id,
                    "fee": {"type": "level", "config": {"feeLevel": "MEDIUM"}},
                },
                timeout=30,
            )
            r.raise_for_status()
            return r.json().get("data", {})

    async def get_transaction_status(self, tx_id: str) -> dict:
        """Check Circle transaction status."""
        async with httpx.AsyncClient() as client:
            r = await client.get(
                f"{self.base_url}/transactions/{tx_id}",
                headers=_headers(),
                timeout=15,
            )
            r.raise_for_status()
            return r.json().get("data", {})
