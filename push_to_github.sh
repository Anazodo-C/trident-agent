#!/bin/bash
# Run this once from the trident-agent folder to init git and push to GitHub
# cd ~/Documents/Claude/trident-agent && bash push_to_github.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "🔱 Initialising git for Trident Agent..."

git init -b main
git remote add origin git@github.com:Anazodo-C/trident-agent.git 2>/dev/null || \
  git remote set-url origin git@github.com:Anazodo-C/trident-agent.git

git add .
git commit -m "feat: complete Trident Agent rebuild — contracts, backends, frontend, CI/CD

- 5 Solidity contracts (TridentToken, TridentFaucet, AgentRegistry, TridentEscrow, ReputationBond)
- FastAPI Python backend (Retrobot engine, marketplace, reputation, agents, faucet)
- Node.js x402 backend (Circle Gateway middleware, 5 paid endpoints + Retrobot service)
- React + Wagmi v2 + RainbowKit frontend (Marketplace, Retrobot, Reputation modules)
- LangChain agents (buyer, seller, retrobot_agent)
- CI/CD: GitHub Actions → Vercel + Railway
- AI-native: llms.txt, agent-card.json, openapi.json"

echo ""
echo "🚀 Pushing to GitHub..."
git push -u origin main --force

echo ""
echo "✅ Done! Repo live at: https://github.com/Anazodo-C/trident-agent"
