import express from "express";
import cors from "cors";
import "dotenv/config";

import { gateway, SELLER_ADDRESS, FACILITATOR_URL } from "./gateway.js";
import { priceFeedRouter } from "./routes/priceFeed.js";
import { fxRatesRouter } from "./routes/fxRates.js";
import { riskScoreRouter } from "./routes/riskScore.js";
import { computeRouter } from "./routes/compute.js";
import { retrobotServiceRouter } from "./routes/retrobotService.js";

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

app.listen(PORT, () => {
  console.log(`🔱 Trident Node Backend running on port ${PORT}`);
  console.log(`   Seller: ${SELLER_ADDRESS}`);
  console.log(`   Facilitator: ${FACILITATOR_URL}`);
  console.log(`   Chain: Arc Testnet (eip155:5042002)`);
});
