"""
Web3.py wrappers for Trident smart contracts on Arc Testnet.
"""
from web3 import Web3
from web3.middleware import geth_poa_middleware
import json
import logging
from config import get_settings

logger = logging.getLogger(__name__)
settings = get_settings()

# Minimal ABI fragments — extend as needed
ESCROW_ABI = json.loads("""[
  {"name": "executeRecovery", "type": "function", "stateMutability": "nonpayable",
   "inputs": [
     {"name": "jobId", "type": "uint256"},
     {"name": "recipient", "type": "address"},
     {"name": "amount", "type": "uint256"},
     {"name": "recoveryReason", "type": "string"}
   ],
   "outputs": []},
  {"name": "flagAnomaly", "type": "function", "stateMutability": "nonpayable",
   "inputs": [
     {"name": "jobId", "type": "uint256"},
     {"name": "anomaly", "type": "uint8"},
     {"name": "reason", "type": "string"}
   ],
   "outputs": []},
  {"name": "getJob", "type": "function", "stateMutability": "view",
   "inputs": [{"name": "jobId", "type": "uint256"}],
   "outputs": [{"name": "", "type": "tuple",
     "components": [
       {"name": "jobId", "type": "uint256"}, {"name": "buyer", "type": "address"},
       {"name": "seller", "type": "address"}, {"name": "agreedAmount", "type": "uint256"},
       {"name": "actualPaid", "type": "uint256"}, {"name": "status", "type": "uint8"}
     ]
   }]}
]""")

REGISTRY_ABI = json.loads("""[
  {"name": "registerAgent", "type": "function", "stateMutability": "nonpayable",
   "inputs": [
     {"name": "agentType", "type": "uint8"},
     {"name": "agentCardURI", "type": "string"},
     {"name": "serviceEndpoint", "type": "string"},
     {"name": "serviceTypes", "type": "string[]"}
   ],
   "outputs": [{"name": "agentId", "type": "uint256"}]},
  {"name": "addressToAgentId", "type": "function", "stateMutability": "view",
   "inputs": [{"name": "", "type": "address"}],
   "outputs": [{"name": "", "type": "uint256"}]}
]""")

TRID_ABI = json.loads("""[
  {"name": "balanceOf", "type": "function", "stateMutability": "view",
   "inputs": [{"name": "account", "type": "address"}],
   "outputs": [{"name": "", "type": "uint256"}]},
  {"name": "approve", "type": "function", "stateMutability": "nonpayable",
   "inputs": [{"name": "spender", "type": "address"}, {"name": "amount", "type": "uint256"}],
   "outputs": [{"name": "", "type": "bool"}]}
]""")


def get_w3() -> Web3:
    w3 = Web3(Web3.HTTPProvider(settings.arc_rpc_url))
    w3.middleware_onion.inject(geth_poa_middleware, layer=0)
    return w3


class TridentEscrowClient:
    def __init__(self):
        self.w3 = get_w3()
        self.account = self.w3.eth.account.from_key(settings.deployer_private_key)
        self.contract = self.w3.eth.contract(
            address=Web3.to_checksum_address(settings.trident_escrow_address),
            abi=ESCROW_ABI,
        )

    async def execute_recovery(
        self, job_id: int, recipient: str, amount: int, reason: str
    ) -> str:
        if not settings.trident_escrow_address:
            raise ValueError("TRIDENT_ESCROW_ADDRESS not set in .env")

        fn = self.contract.functions.executeRecovery(
            job_id,
            Web3.to_checksum_address(recipient),
            amount,
            reason,
        )
        tx = fn.build_transaction({
            "from": self.account.address,
            "nonce": self.w3.eth.get_transaction_count(self.account.address),
            "gasPrice": self.w3.eth.gas_price,
        })
        signed = self.account.sign_transaction(tx)
        tx_hash = self.w3.eth.send_raw_transaction(signed.rawTransaction)
        receipt = self.w3.eth.wait_for_transaction_receipt(tx_hash, timeout=120)
        logger.info(f"Recovery tx confirmed: {receipt.transactionHash.hex()}")
        return receipt.transactionHash.hex()

    async def flag_anomaly(self, job_id: int, anomaly_type: int, reason: str) -> str:
        fn = self.contract.functions.flagAnomaly(job_id, anomaly_type, reason)
        tx = fn.build_transaction({
            "from": self.account.address,
            "nonce": self.w3.eth.get_transaction_count(self.account.address),
            "gasPrice": self.w3.eth.gas_price,
        })
        signed = self.account.sign_transaction(tx)
        tx_hash = self.w3.eth.send_raw_transaction(signed.rawTransaction)
        receipt = self.w3.eth.wait_for_transaction_receipt(tx_hash, timeout=120)
        return receipt.transactionHash.hex()


class AgentRegistryClient:
    def __init__(self):
        self.w3 = get_w3()
        self.account = self.w3.eth.account.from_key(settings.deployer_private_key)
        self.contract = self.w3.eth.contract(
            address=Web3.to_checksum_address(settings.agent_registry_address),
            abi=REGISTRY_ABI,
        )

    async def get_agent_id(self, wallet: str) -> int:
        return self.contract.functions.addressToAgentId(
            Web3.to_checksum_address(wallet)
        ).call()


class TridTokenClient:
    def __init__(self):
        self.w3 = get_w3()
        self.contract = self.w3.eth.contract(
            address=Web3.to_checksum_address(settings.trident_token_address),
            abi=TRID_ABI,
        )

    async def balance_of(self, wallet: str) -> int:
        return self.contract.functions.balanceOf(
            Web3.to_checksum_address(wallet)
        ).call()
