from pydantic_settings import BaseSettings
from functools import lru_cache


class Settings(BaseSettings):
    # Arc Testnet
    arc_rpc_url: str = "https://rpc.testnet.arc.network"
    arc_chain_id: int = 5042002
    arc_usdc_address: str = "0x3600000000000000000000000000000000000000"
    arc_eurc_address: str = "0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a"

    # Deployer
    deployer_address: str = "0x3315ebaab06d6266e92f6063b9360ae10d24F0a0"
    deployer_private_key: str = ""

    # Contract addresses (filled after deployment)
    trident_token_address: str = ""
    trident_faucet_address: str = ""
    agent_registry_address: str = ""
    trident_escrow_address: str = ""
    reputation_bond_address: str = ""

    # Circle
    circle_api_key: str = ""
    circle_entity_secret: str = ""
    circle_wallet_set_id: str = ""
    circle_environment: str = "testnet"

    # Anthropic
    anthropic_api_key: str = ""

    # Financial APIs
    coingecko_api_key: str = ""
    alpha_vantage_api_key: str = ""
    messari_api_key: str = ""

    # App
    database_url: str = "postgresql+asyncpg://user:password@localhost:5432/trident"
    secret_key: str = "change-me-in-production"
    backend_port: int = 8000
    frontend_url: str = "http://localhost:5173"
    node_backend_url: str = "http://localhost:3001"

    class Config:
        env_file = ".env"
        extra = "ignore"


@lru_cache()
def get_settings() -> Settings:
    return Settings()
