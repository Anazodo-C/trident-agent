#!/bin/bash
set -e

# Resolve project root (one level up from contracts/)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

# Load .env from project root
if [ -f "$PROJECT_ROOT/.env" ]; then
  export $(grep -v '^#' "$PROJECT_ROOT/.env" | xargs)
fi

if [ -z "$DEPLOYER_PRIVATE_KEY" ]; then
  echo "❌ DEPLOYER_PRIVATE_KEY not set in .env"
  exit 1
fi

echo "🔱 Deploying Trident Protocol to Arc Testnet..."
echo "   Deployer: $DEPLOYER_ADDRESS"
echo "   RPC: https://rpc.testnet.arc.network"
echo ""

cd "$SCRIPT_DIR"

# Install OpenZeppelin if not present
if [ ! -d "lib/openzeppelin-contracts" ]; then
  echo "📦 Installing OpenZeppelin..."
  forge install OpenZeppelin/openzeppelin-contracts
fi

echo "🔨 Building contracts..."
forge build

echo "🚀 Broadcasting deployment..."
forge script script/Deploy.s.sol:DeployTrident \
  --rpc-url https://rpc.testnet.arc.network \
  --private-key "$DEPLOYER_PRIVATE_KEY" \
  --broadcast --legacy -vvvv

echo ""
echo "✅ Deployment complete! Copy the addresses above into your .env file."
echo "   Then run: source .env"
