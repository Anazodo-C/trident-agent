// Polyfill Web Crypto for Node < 19
import { webcrypto } from "node:crypto";
if (!globalThis.crypto) {
  (globalThis as any).crypto = webcrypto;
}

// BigInt JSON serialization — GatewayClient returns token amounts as BigInt,
// which JSON.stringify() cannot handle natively. Convert to string globally.
(BigInt.prototype as any).toJSON = function () {
  return this.toString();
};

import express from "express";
import cors from "cors";
import "dotenv/config";

import { gateway, SELLER_ADDRESS, FACILITATOR_URL } from "./gateway.js";
import { priceFeedRouter } from "./routes/priceFeed.js";
import { fxRatesRouter } from "./routes/fxRates.js";
import { riskScoreRouter } from "./routes/riskScore.js";
import { computeRouter } from "./routes/compute.js";
import { retrobotServiceRouter } from "./routes/retrobotService.js";
import { hireRouter } from "./routes/hire.js";
import { startBuyerAgents } from "./buyerAgents.js";
import { gatewayClient } from "./gatewayClient.js";
// tridFaucet: disabled — buyer agents get a one-time 100k TRID drop via DB seed
// import { startTridFaucetLoop } from "./tridFaucet.js";

const app = express();
const PORT = process.env.PORT || process.env.NODE_PORT || 3001;

app.use(cors({ origin: "*" }));
app.use(express.json());

app.get("/", (req, res) => {
  res.json({
    name: "Trident Agent — Financial Intelligence API",
    version: "1.0.0",
    chain: "Arc Testnet",
    chain_id: 5042002,
    caip2: "eip155:5042002",
    payment_protocol: "x402",
    facilitator: FACILITATOR_URL,
    seller_address: SELLER_ADDRESS,
    currency: "USDC",
    services: [
      { name: "Price Feed", endpoint: "/data/price-feed", price_usdc: "0.001", description: "Live crypto asset prices" },
      { name: "FX Rates", endpoint: "/data/fx-rates", price_usdc: "0.001", description: "Real-time forex rates incl. emerging markets" },
      { name: "Risk Score", endpoint: "/data/risk-score", price_usdc: "0.005", description: "Wallet and asset risk scoring" },
      { name: "Compute Score", endpoint: "/data/compute-score", price_usdc: "0.020", description: "Quantitative portfolio scoring (Sharpe, VaR)" },
      { name: "Retrobot Audit", endpoint: "/retrobot/audit", price_usdc: "0.005", description: "Full payment history anomaly audit" },
      { name: "Retrobot Scan", endpoint: "/retrobot/scan", price_usdc: "0.001", description: "Single transaction anomaly scan" },
      { name: "Retrobot Recover", endpoint: "/retrobot/recover", price_usdc: "0.010", description: "Initiate payment recovery flow" },
    ],
  });
});

app.get("/llms.txt", (req, res) => {
  res.type("text/plain").send(`# Trident Agent API
> Financial intelligence marketplace on Arc Testnet. AI agents pay per call via x402/Gateway.

## Payment Protocol
- Standard: x402 (HTTP 402 Payment Required)
- Chain: Arc Testnet (eip155:5042002)
- Currency: USDC (0x3600000000000000000000000000000000000000)
- Facilitator: ${FACILITATOR_URL}
- Seller: ${SELLER_ADDRESS}

## How to Pay
1. Deposit USDC into Gateway: GatewayClient({ chain: "arcTestnet", privateKey })
2. Call any endpoint — receive 402 with PAYMENT-REQUIRED header
3. Sign EIP-3009 authorization offchain (zero gas)
4. Retry with PAYMENT-SIGNATURE header
5. Receive data

## Services
GET /data/price-feed?symbols=BTC,ETH — $0.001 USDC — Live crypto prices
GET /data/fx-rates?base=USD&targets=EUR,NGN,BRL — $0.001 USDC — FX rates
GET /data/risk-score?address=0x... — $0.005 USDC — Wallet risk score
GET /data/compute-score?portfolio=... — $0.020 USDC — Portfolio scoring
POST /retrobot/audit — $0.005 USDC — Payment audit
POST /retrobot/scan — $0.001 USDC — Anomaly scan
POST /retrobot/recover — $0.010 USDC — Recovery initiation

## OpenAPI
GET /openapi.json — Full OpenAPI 3.1 spec
GET /.well-known/agent-card.json — ERC-8004 agent card
`);
});

app.get("/.well-known/agent-card.json", (req, res) => {
  res.json({
    "@context": "https://erc8004.org/schema",
    name: "Trident Financial Intelligence Agent",
    description: "AI agent marketplace for financial data — prices, FX rates, risk scores, portfolio scoring. Powered by Arc + Circle Gateway.",
    version: "1.0.0",
    wallet: { caip10: `eip155:5042002:${SELLER_ADDRESS}`, chain: "Arc Testnet", chain_id: 5042002 },
    payment: { protocol: "x402", currency: "USDC", network: "eip155:5042002", facilitator: FACILITATOR_URL },
    capabilities: ["price_feed", "fx_rates", "risk_score", "compute_score", "payment_audit", "payment_recovery"],
    endpoints: { base: `http://localhost:${PORT}`, openapi: "/openapi.json", llms_txt: "/llms.txt" },
  });
});

app.get("/openapi.json", (req, res) => {
  res.json({
    openapi: "3.1.0",
    info: { title: "Trident Agent API", version: "1.0.0", description: "Financial intelligence marketplace. All paid endpoints require x402 payment via Circle Gateway." },
    servers: [{ url: `http://localhost:${PORT}` }],
    paths: {
      "/data/price-feed": { get: { summary: "Live crypto price feed", parameters: [{ name: "symbols", in: "query", schema: { type: "string", example: "BTC,ETH,USDC" } }], responses: { "200": { description: "Price data" }, "402": { description: "Payment required" } }, "x-price-usdc": "0.001" } },
      "/data/fx-rates": { get: { summary: "FX rates including emerging markets", parameters: [{ name: "base", in: "query", schema: { type: "string", example: "USD" } }, { name: "targets", in: "query", schema: { type: "string", example: "EUR,GBP,NGN,BRL" } }], responses: { "200": { description: "FX rate data" }, "402": { description: "Payment required" } }, "x-price-usdc": "0.001" } },
      "/data/risk-score": { get: { summary: "Wallet risk score", parameters: [{ name: "address", in: "query", schema: { type: "string" } }], responses: { "200": { description: "Risk score" }, "402": { description: "Payment required" } }, "x-price-usdc": "0.005" } },
    },
  });
});

app.use("/data", priceFeedRouter);
app.use("/data", fxRatesRouter);
app.use("/data", riskScoreRouter);
app.use("/data", computeRouter);
app.use("/retrobot", retrobotServiceRouter);
app.use("/hire", hireRouter);

// ── Agent key generation (one-time, called on signup) ────────────────────────
app.post("/auth/create-agent", (req, res) => {
  // Dynamically import viem/accounts to generate a fresh EOA
  import("viem/accounts").then(({ generatePrivateKey, privateKeyToAccount }) => {
    const privateKey = generatePrivateKey();               // 0x + 64 hex chars
    const account    = privateKeyToAccount(privateKey);
    res.json({
      address:    account.address,
      privateKey,                                          // shown to user ONCE — never stored
      warning:    "SAVE THIS PRIVATE KEY NOW. It will never be shown again. Anyone with this key controls your agent wallet.",
      arcscan:    `https://testnet.arcscan.app/address/${account.address}`,
    });
  }).catch(err => {
    res.status(500).json({ error: "Key generation failed", detail: err.message });
  });
});

app.get("/wallet-status", async (req, res) => {
  try {
    const balances = gatewayClient ? await gatewayClient.getBalances() : null;
    res.json({
      seller: {
        address: SELLER_ADDRESS,
        arcscan: `https://testnet.arcscan.app/address/${SELLER_ADDRESS}`,
        note: "Receives TRID on-chain (from user MetaMask) + USDC via Circle Gateway",
      },
      buyer_agent: {
        address: gatewayClient?.address ?? null,
        arcscan: gatewayClient?.address
          ? `https://testnet.arcscan.app/address/${gatewayClient.address}`
          : null,
        usdc_wallet: balances?.wallet?.formatted ?? "n/a",
        usdc_gateway: balances?.gateway?.formattedTotal ?? "n/a",
        enabled: gatewayClient !== null,
        note: "Circle EOA wallet — owned via your Circle Developer account",
      },
    });
  } catch (err: any) {
    res.status(500).json({ error: err?.message ?? "balance fetch failed" });
  }
});

app.get("/buyer-agent-status", (req, res) => {
  res.json({
    enabled: gatewayClient !== null,
    address: gatewayClient?.address ?? null,
    chain: "arcTestnet",
    message: gatewayClient
      ? "Circle Gateway buyer agent active — making real x402 payments"
      : "Set BUYER_AGENT_PRIVATE_KEY and fund at faucet.circle.com to enable",
  });
});

// ── User agent: deposit USDC into Circle Gateway ──────────────────────────────
// Called from the frontend after decrypting the user's agent private key.
// privateKey + amount_usdc → creates a one-shot GatewayClient → deposits.
app.post("/user/gateway-deposit", async (req, res) => {
  const { private_key, amount_usdc } = req.body as { private_key?: string; amount_usdc?: number };

  if (!private_key || !amount_usdc || amount_usdc <= 0) {
    return res.status(400).json({ error: "private_key and amount_usdc (>0) are required" });
  }

  try {
    const { GatewayClient } = await import("@circle-fin/x402-batching/client");
    const pk = (private_key.startsWith("0x") ? private_key : `0x${private_key}`) as `0x${string}`;

    const client = new GatewayClient({
      chain: "arcTestnet",
      privateKey: pk,
      rpcUrl: "https://rpc.testnet.arc.network",
    });

    const amountStr = amount_usdc.toFixed(6);
    await client.deposit(amountStr as any);

    // Fetch updated balances to confirm deposit (getBalances returns formatted strings, no BigInt)
    let gatewayUsdc: string | null = null;
    try {
      const bal = await client.getBalances();
      gatewayUsdc = bal?.gateway?.formattedTotal ?? null;
    } catch { /* non-fatal */ }

    res.json({
      success: true,
      address: client.address,
      amount_deposited: amountStr,
      gateway_usdc: gatewayUsdc,
      note: "USDC deposited into Circle Gateway — your agent can now make x402 payments",
    });
  } catch (err: any) {
    const msg = err?.message ?? String(err);
    res.status(500).json({
      error: "Deposit failed",
      detail: msg,
      hint: msg.includes("insufficient") || msg.includes("balance")
        ? "Your agent wallet may not have enough USDC. Get testnet USDC at faucet.circle.com."
        : undefined,
    });
  }
});

// ── User agent: check gateway balance for any private key ─────────────────────
app.post("/user/gateway-balance", async (req, res) => {
  const { private_key } = req.body as { private_key?: string };
  if (!private_key) {
    return res.status(400).json({ error: "private_key is required" });
  }
  try {
    const { GatewayClient } = await import("@circle-fin/x402-batching/client");
    const pk = (private_key.startsWith("0x") ? private_key : `0x${private_key}`) as `0x${string}`;
    const client = new GatewayClient({
      chain: "arcTestnet",
      privateKey: pk,
      rpcUrl: "https://rpc.testnet.arc.network",
    });
    const balances = await client.getBalances();
    res.json({
      address: client.address,
      wallet_usdc: balances?.wallet?.formatted ?? "0",
      gateway_usdc: balances?.gateway?.formattedTotal ?? "0",
    });
  } catch (err: any) {
    res.status(500).json({ error: err?.message ?? "balance check failed" });
  }
});

app.listen(PORT, () => {
  console.log(`🔱 Trident Node Backend running on port ${PORT}`);
  console.log(`   Seller:      ${SELLER_ADDRESS}`);
  console.log(`   Facilitator: ${FACILITATOR_URL}`);
  console.log(`   Chain:       Arc Testnet (eip155:5042002)`);
  // Start buyer agents after the server is listening so self-calls work
  startBuyerAgents();
  // tridFaucetLoop disabled — demo buyers get 100k TRID via DB seed on Python startup
});
