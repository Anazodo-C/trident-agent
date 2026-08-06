# Trident v1

A consumer-grade agentic workspace over Circle's Agent Stack. Every user gets one
AI agent with one wallet. The agent scouts x402-protected API services, presents a
costed plan for approval, then executes it autonomously — spending USDC from the
user's agent wallet in real time.

> v0 (the `$TRID` marketplace, Retrobot, and Foundry contracts) lives on the
> `main` and `v0-snapshot` branches. This branch is a clean-room v1.

## Architecture

Every user has exactly one wallet: a per-user EOA generated server-side at signup.

```
signup  → viem generatePrivateKey() → AES-256-GCM encrypted with the user's
          passphrase (PBKDF2-SHA256, 200_000 iterations) → raw key discarded,
          only ciphertext stored
login   → user enters passphrase → browser decrypts via WebCrypto → key held in
          Zustand memory only, lost on refresh
```

The raw private key is never persisted, logged, or returned by the API. The server
only ever hands back ciphertext (`GET /auth/key-material`).

```
External wallet (MetaMask, …)   only to send funds TO the agent wallet
        ↓
Agent wallet (EOA)
        ↓ GatewayClient.deposit()
Circle Gateway balance
        ↓ x402 EIP-3009 signed by the EOA key
API provider
```

OAuth users never need a Web3 wallet — their passphrase *is* their signing credential.

## Layout

```
apps/
├── frontend/       React 18 + Vite + Tailwind v4 + Zustand + wagmi/RainbowKit
└── node-backend/   Node 20+ / Express / better-sqlite3, TypeScript ESM
```

## Setup

```bash
npm install
```

Create `.env` at the repo root (the backend loads the root file as well as its own):

| Variable | Required | Notes |
|---|---|---|
| `JWT_SECRET` | yes in prod | dev falls back to an insecure default |
| `ANTHROPIC_API_KEY` | yes | the planner returns 503 without it |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | optional | Google sign-in is hidden when absent; SIWE still works |
| `GOOGLE_REDIRECT_URI` | optional | defaults to `http://localhost:3001/auth/google/callback` |
| `FRONTEND_URL` | optional | defaults to `http://localhost:5173` |
| `PORT` | optional | defaults to `3001` |
| `DB_PATH` | optional | defaults to `./trident.db` |
| `VITE_WALLETCONNECT_PROJECT_ID` | optional | frontend; without it only injected wallets work |
| `VITE_API_BASE_URL` | yes in prod | frontend build-time backend origin, e.g. `https://trident-api.up.railway.app`. Empty in dev (Vite proxies). Without it, a deployed frontend 404s on every API call. |

## Running

```bash
npm run dev:backend
```

```bash
npm run dev:frontend
```

Vite proxies `/api` and `/auth` to `http://localhost:3001`.

## Tests

```bash
npm run test -w @trident/node-backend
```

- `test:planner` — JSON extraction, schema coercion, and the endpoint allowlist
  that stops a hallucinated URL from becoming a real payment. No network.
- `test:runner` — budget gate, spending-cap gate, abort flag, SSE framing, and
  the guarantee that a private key never reaches the stream or the database.
  Includes a real (unfunded) payment attempt against a live x402 endpoint.
- `test:e2e` — needs the backend running. Full SIWE signup → passphrase → key
  round trip → wallet reads → planner → history, plus cross-account isolation.

The E2E crypto section decrypts using the **frontend's** WebCrypto module, which
is what proves the server and browser key derivations actually agree.

## Deploy

- Backend → Railway via the root `nixpacks.toml`.
- Frontend → Vercel via the root `vercel.json`.

Both configs live at the repo root and use explicit paths, so neither platform
needs a Root Directory set in its dashboard. Each scopes its install to one
workspace: Vercel never compiles `better-sqlite3`, and Railway never installs
the frontend's ~700 packages.

The two deployments must know about each other, or the app will not work:

1. Deploy the backend first and note its URL.
2. Set `VITE_API_BASE_URL` to that URL in Vercel's project settings, then
   redeploy the frontend (it is inlined at build time, not read at runtime).
3. Set `FRONTEND_URL` on the backend to the Vercel URL — CORS is restricted to
   it in production, and it is where the OAuth callback redirects.
4. If using Google sign-in, add `<backend>/auth/google/callback` to the
   authorised redirect URIs in the Google Cloud console and set
   `GOOGLE_REDIRECT_URI` to match.

Note: SQLite on Railway needs a mounted volume for `DB_PATH`, otherwise the
database is lost on redeploy.

## Verified SDK behaviour

Checked against the installed packages rather than assumed:

| Item | Result |
|---|---|
| `GatewayClient.pay(url, { method, body })` | correct |
| `GatewayClient.withdraw(amount, { chain, recipient, maxFee })` | exists |
| `GatewayClient.deposit(amount: string)` | correct |
| `getBalances()` → `{ wallet, gateway: { formattedTotal, … } }` | correct |
| ARC-TESTNET USDC `0x3600…0000` | correct — read from `CHAIN_CONFIGS`, not hardcoded |
| PBKDF2 200k parity, server ⇄ browser | verified by test |
| `@circle-fin/bridge-kit` | **the assumed `createBridgeClient()` API does not exist**; uses `new BridgeKit()` + `kit.bridge({ from, to, amount })` with `@circle-fin/adapter-viem-v2` |
| Circle fiat onramp | no public API for a custom destination address; testnet uses the Circle faucet |
| `x402.x.com` | domain does not resolve — removed from the catalog |

Arc Testnet: chain ID `5042002`, RPC `https://rpc.testnet.arc.network`, explorer
`https://testnet.arcscan.app`, faucet `https://faucet.circle.com`. Its native gas
token is also called USDC (18 decimals) and is distinct from the 6-decimal ERC-20.

## Service registry

`agents.circle.com` exposes no public JSON API — its catalogue is server-rendered
and its JS bundle contains no fetch URLs. The x402 ecosystem does publish a
discovery API, which is a superset of Circle's marketplace and flags it via
`curated`:

```
https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources
```

`registryService.ts` mirrors it into SQLite — ~14,400 services, a full sync in
about 20s — refreshed on boot and every 6 hours, so newly published services
appear without a deploy. `POST /api/services/sync` forces a refresh.

Services are tiered by evidence, not opinion:

| Tier | Meaning |
|---|---|
| `curated` | in Circle's marketplace (~120) |
| `active` | has recorded traffic in the last 30 days |
| `untested` | listed, but no recorded usage — flagged, never hidden |

A registry this size cannot go in a prompt, so `candidateService.ts` retrieves a
shortlist (~40) for each goal and only that reaches the model. Ranking favours
curated and well-used services, but nothing is excluded — an obscure service can
still win if it is the only real match, and the approval card warns when a step
uses an `untested` endpoint.

## Chains and mainnet opt-in

Almost the entire registry settles on **mainnet** (Base carries ~14,400 of the
services; only 93 are testnet-payable, and just 2 on Arc Testnet). So:

- **Arc Testnet is the default** — a verification tier. A user can prove their
  wallet, passphrase and payment pipeline work with free faucet USDC.
- **Base is the mainnet default**, and is **opt-in**. Until a user enables it in
  Wallet, an approved plan cannot spend real money.

`chainPolicy.ts` is the single gate. The runner resolves each step's chain from
the registry rather than trusting the request, so a tampered payload cannot move
spending onto mainnet. Testnet is preferred whenever a service supports both.

Arc mainnet is already in the SDK (chainId 5042, Gateway domain 26), so
switching when it goes live is a config change — it needs an RPC URL, as do
Base, Arbitrum and Optimism.
