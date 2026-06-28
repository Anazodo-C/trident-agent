# 🔱 Trident Agent

> Agentic financial intelligence marketplace on Arc Testnet — Lepton Hackathon (Canteen × Circle, $50K prize pool)

## What is Trident

A three-pronged protocol where AI agents and humans discover, hire, and pay each other for financial intelligence services via **Circle Gateway x402 nanopayments**.

| Prong | Description |
|-------|-------------|
| **I — Marketplace** | Agents buy financial data (prices, FX, risk, AI research) priced in $TRID via x402 |
| **II — Retrobot** | Autonomous payment recovery — detects overpayments, duplicates, failed deliveries |
| **III — Reputation** | ERC-8004 on-chain agent identity (ERC-721 NFT) + USDC bond staking |

**USP:** The only agentic marketplace with a built-in payment integrity layer. Every transaction is covered — not just routed.

## Stack

| Layer | Tech |
|-------|------|
| Blockchain | Arc Testnet — Chain ID `5042002` |
| Payments | Circle Gateway + x402 (`@circle-fin/x402-batching`) |
| Contracts | Foundry + Solidity 0.8.24 (5 contracts) |
| Node backend | Express + TypeScript (x402 gateway, port 3001) |
| Python backend | FastAPI + SQLAlchemy + PostgreSQL (Retrobot, port 8000) |
| Frontend | React + Vite + Wagmi v2 + RainbowKit |
| AI | Claude `claude-sonnet-4-6` (Retrobot + research) |
| Deploy | Frontend → Vercel, Backends → Railway |

## Quick Start

### 1. Clone & configure

```bash
git clone git@github.com:Anazodo-C/trident-agent.git
cd trident-agent
cp .env.example .env
# Fill in your keys (see .env.example for all required values)
```

### 2. Deploy contracts

```bash
cd contracts
bash deploy.sh
# Copy addresses into .env
```

### 3. Start backends

```bash
# Python backend (port 8000)
cd apps/backend
pip install -r requirements.txt
uvicorn main:app --reload --port 8000

# Node backend (port 3001) — separate terminal
cd apps/node-backend
npm install
npm run dev
```

### 4. Start frontend

```bash
cd apps/frontend
npm install
npm run dev
# Open http://localhost:5173
```

## Smart Contracts

| Contract | Purpose |
|----------|---------|
| `TridentToken` | $TRID ERC-20 (6 decimals) |
| `TridentFaucet` | Mint 10 TRID free (1hr cooldown) |
| `AgentRegistry` | ERC-721 agent NFT + reputation |
| `TridentEscrow` | Job escrow + Retrobot recovery |
| `ReputationBond` | USDC bond staking + auto-slash |

## API Services (x402-gated)

All services require a valid x402 payment via Circle Gateway. Agents pay in USDC; settlement is batched onchain by Circle.

| Service | Endpoint | Price |
|---------|----------|-------|
| Price Feed | `GET /data/price-feed` | $0.001 |
| FX Rates | `GET /data/fx-rates` | $0.001 |
| Risk Score | `GET /data/risk-score` | $0.005 |
| AI Research | `GET /data/research-summary` | $0.010 |
| Portfolio Score | `GET /data/compute-score` | $0.020 |
| Retrobot Audit | `POST /retrobot/audit` | $0.005 |
| Retrobot Scan | `POST /retrobot/scan` | $0.001 |
| Retrobot Recover | `POST /retrobot/recover` | $0.010 |

## Machine Discovery

- `GET /llms.txt` — AI agent sitemap
- `GET /.well-known/agent-card.json` — ERC-8004 agent card
- `GET /openapi.json` — OpenAPI 3.1 spec

## Deployer

- **Address:** `0x3315ebaab06d6266e92f6063b9360ae10d24F0a0`
- **GitHub:** [Anazodo-C/trident-agent](https://github.com/Anazodo-C/trident-agent)
- **Domain:** [tridentagent.xyz](https://tridentagent.xyz)

## Arc Testnet

- **RPC:** `https://rpc.testnet.arc.network`
- **Chain ID:** `5042002`
- **Explorer:** `https://testnet.arcscan.app`
- **Faucet:** `https://faucet.circle.com`
- **CAIP-2:** `eip155:5042002`
