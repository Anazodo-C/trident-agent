"""
Arc-native ERC-8004 Identity Registry client.
Contracts: https://docs.arc.network/arc/tutorials/register-your-first-ai-agent
"""
from web3 import Web3
from web3.middleware import ExtraDataToPOAMiddleware
import logging
from config import get_settings

logger = logging.getLogger(__name__)
settings = get_settings()

# Arc-native ERC-8004 contracts (permanent addresses on Arc Testnet)
ARC_IDENTITY_REGISTRY = "0x8004A818BFB912233c491871b3d84c89A494BD9e"
ARC_REPUTATION_REGISTRY = "0x8004B663056A597Dffe9eCcC1965A193B7388713"
ARC_VALIDATION_REGISTRY = "0x8004Cb1BF31DAf7788923b405b754f57acEB4272"

IDENTITY_ABI = [
    {
        "name": "registerAgent",
        "type": "function",
        "stateMutability": "nonpayable",
        "inputs": [
            {"name": "owner", "type": "address"},
            {"name": "metadataURI", "type": "string"},
        ],
        "outputs": [{"name": "agentId", "type": "uint256"}],
    },
    {
        "name": "getAgent",
        "type": "function",
        "stateMutability": "view",
        "inputs": [{"name": "agentId", "type": "uint256"}],
        "outputs": [
            {"name": "owner", "type": "address"},
            {"name": "metadataURI", "type": "string"},
            {"name": "registeredAt", "type": "uint256"},
        ],
    },
    {
        "name": "ownerToAgentId",
        "type": "function",
        "stateMutability": "view",
        "inputs": [{"name": "owner", "type": "address"}],
        "outputs": [{"name": "", "type": "uint256"}],
    },
]

REPUTATION_ABI = [
    {
        "name": "recordEvent",
        "type": "function",
        "stateMutability": "nonpayable",
        "inputs": [
            {"name": "agentId", "type": "uint256"},
            {"name": "score", "type": "int256"},
            {"name": "reason", "type": "string"},
        ],
        "outputs": [],
    },
    {
        "name": "getReputation",
        "type": "function",
        "stateMutability": "view",
        "inputs": [{"name": "agentId", "type": "uint256"}],
        "outputs": [{"name": "score", "type": "int256"}],
    },
]


def get_w3() -> Web3:
    w3 = Web3(Web3.HTTPProvider(settings.arc_rpc_url))
    w3.middleware_onion.inject(ExtraDataToPOAMiddleware, layer=0)
    return w3


class ArcIdentityClient:
    """
    Wraps Arc's native ERC-8004 IdentityRegistry.
    Used to give every Trident agent a canonical on-chain identity at creation.
    """

    def __init__(self):
        self.w3 = get_w3()
        if settings.deployer_private_key:
            self.account = self.w3.eth.account.from_key(settings.deployer_private_key)
        else:
            self.account = None
        self.identity = self.w3.eth.contract(
            address=Web3.to_checksum_address(ARC_IDENTITY_REGISTRY),
            abi=IDENTITY_ABI,
        )
        self.reputation = self.w3.eth.contract(
            address=Web3.to_checksum_address(ARC_REPUTATION_REGISTRY),
            abi=REPUTATION_ABI,
        )

    def build_metadata_uri(self, agent_name: str, agent_type: str, wallet: str) -> str:
        """
        Returns an inline data-URI with agent card JSON.
        In production, upload to IPFS and return the ipfs:// URI.
        """
        import json, base64
        card = {
            "@context": "https://erc8004.org/schema",
            "name": agent_name,
            "type": agent_type,
            "wallet": wallet,
            "platform": "Trident Agent — Arc Testnet",
            "capabilities": ["x402_payment", "retrobot_scan"],
            "endpoint": "https://tridentagent.xyz",
        }
        encoded = base64.b64encode(json.dumps(card).encode()).decode()
        return f"data:application/json;base64,{encoded}"

    async def register_identity(
        self, owner_address: str, agent_name: str, agent_type: str
    ) -> dict:
        """
        Register agent on Arc's native IdentityRegistry.
        Returns agentId + tx hash on success, or a graceful error dict.
        """
        if not self.account:
            logger.warning("No deployer key — skipping Arc identity registration")
            return {"registered": False, "reason": "no_deployer_key"}

        try:
            metadata_uri = self.build_metadata_uri(agent_name, agent_type, owner_address)
            owner_cs = Web3.to_checksum_address(owner_address)

            # Check if already registered
            try:
                existing_id = self.identity.functions.ownerToAgentId(owner_cs).call()
                if existing_id > 0:
                    return {
                        "registered": True,
                        "arc_agent_id": existing_id,
                        "already_existed": True,
                        "identity_registry": ARC_IDENTITY_REGISTRY,
                    }
            except Exception:
                pass

            fn = self.identity.functions.registerAgent(owner_cs, metadata_uri)
            gas_est = fn.estimate_gas({"from": self.account.address})
            tx = fn.build_transaction({
                "from": self.account.address,
                "nonce": self.w3.eth.get_transaction_count(self.account.address),
                "gas": int(gas_est * 1.2),
                "gasPrice": self.w3.eth.gas_price,
            })
            signed = self.account.sign_transaction(tx)
            tx_hash = self.w3.eth.send_raw_transaction(signed.raw_transaction)
            receipt = self.w3.eth.wait_for_transaction_receipt(tx_hash, timeout=30)

            # Parse agentId from logs
            arc_agent_id = int(receipt.logs[0].data.hex(), 16) if receipt.logs else None

            logger.info(f"Arc identity registered: {owner_address} → agentId={arc_agent_id}")
            return {
                "registered": True,
                "arc_agent_id": arc_agent_id,
                "tx_hash": receipt.transactionHash.hex(),
                "identity_registry": ARC_IDENTITY_REGISTRY,
                "arc_scan": f"https://testnet.arcscan.app/tx/{receipt.transactionHash.hex()}",
            }

        except Exception as e:
            logger.warning(f"Arc identity registration failed (non-fatal): {e}")
            return {"registered": False, "reason": str(e)}

    async def record_reputation(self, arc_agent_id: int, score_delta: int, reason: str) -> bool:
        """Record a reputation event on Arc's ReputationRegistry."""
        if not self.account or not arc_agent_id:
            return False
        try:
            fn = self.reputation.functions.recordEvent(arc_agent_id, score_delta, reason)
            tx = fn.build_transaction({
                "from": self.account.address,
                "nonce": self.w3.eth.get_transaction_count(self.account.address),
                "gasPrice": self.w3.eth.gas_price,
            })
            signed = self.account.sign_transaction(tx)
            tx_hash = self.w3.eth.send_raw_transaction(signed.raw_transaction)
            self.w3.eth.wait_for_transaction_receipt(tx_hash, timeout=30)
            return True
        except Exception as e:
            logger.warning(f"Reputation event failed (non-fatal): {e}")
            return False
