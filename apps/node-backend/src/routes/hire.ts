/**
 * POST /hire
 *
 * Frontend-triggered x402 payment. The user hits "Hire" on the marketplace,
 * the frontend calls this endpoint, and we use GatewayClient.pay() to make a
 * real x402 payment to one of our own data endpoints on behalf of the user.
 *
 * Request body:
 *   { service_type: string, params?: Record<string,string>, buyer_address?: string }
 *
 * Response:
 *   { data, service_type, amount_paid, transaction, paid_by }
 */
import { Router } from "express";
import { gatewayClient, buyerEnabled } from "../gatewayClient.js";

export const hireRouter = Router();

const SELF_URL = () =>
  `http://localhost:${process.env.PORT || process.env.NODE_PORT || 3001}`;

function buildEndpoint(service_type: string, params: Record<string, string> = {}): string | null {
  switch (service_type) {
    case "price_feed":
      return `/data/price-feed?symbols=${params.symbols || "BTC,ETH,USDC,SOL"}`;
    case "fx_rates":
      return `/data/fx-rates?base=${params.base || "USD"}&targets=${params.targets || "EUR,GBP,NGN,JPY,BRL,GHS"}`;
    case "risk_score":
      return `/data/risk-score?address=${params.address || "0x0000000000000000000000000000000000000001"}`;
    case "compute_score":
      return `/data/compute-score?portfolio=${encodeURIComponent(params.portfolio || "BTC:0.4,ETH:0.3,SOL:0.2,USDC:0.1")}&model=${params.model || "sharpe"}`;
    case "retrobot_audit":
      return null; // POST endpoint handled separately below
    case "retrobot_scan":
      return null;
    default:
      return null;
  }
}

hireRouter.post("/", async (req, res) => {
  const { service_type, params = {}, buyer_address } = req.body as {
    service_type: string;
    params?: Record<string, string>;
    buyer_address?: string;
  };

  if (!service_type) {
    return res.status(400).json({ error: "service_type is required" });
  }

  // ── Retrobot audit: POST to /retrobot/audit with x402 ──
  if (service_type === "retrobot_audit") {
    if (!buyerEnabled || !gatewayClient) {
      return res.status(402).json({
        error: "x402_not_configured",
        message: "BUYER_AGENT_PRIVATE_KEY not set — set it in Railway and fund the address via faucet.circle.com",
      });
    }
    try {
      const { data, formattedAmount, transaction } = await gatewayClient.pay(
        `${SELF_URL()}/retrobot/audit`,
        {
          method: "POST",
          body: { wallet_address: buyer_address || "0x0000000000000000000000000000000000000001" },
        }
      );
      return res.json({
        data,
        service_type,
        amount_paid: formattedAmount,
        transaction,
        paid_by: gatewayClient.address,
        x402: true,
      });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  }

  // ── All other services: GET with query params ──
  const endpoint = buildEndpoint(service_type, params);
  if (!endpoint) {
    return res.status(400).json({ error: `Unknown service_type: ${service_type}` });
  }

  // If no GatewayClient, fall back to a direct internal call (no payment, shows note)
  if (!buyerEnabled || !gatewayClient) {
    try {
      const r = await fetch(`${SELF_URL()}${endpoint}`, {
        signal: AbortSignal.timeout(10000),
      });
      if (r.status === 402) {
        return res.status(402).json({
          error: "x402_payment_required",
          message: "Set BUYER_AGENT_PRIVATE_KEY in Railway and fund via faucet.circle.com to enable real payments",
          endpoint,
        });
      }
      const data = await r.json();
      return res.json({ data, service_type, amount_paid: null, x402: false, note: "BUYER_AGENT_PRIVATE_KEY not configured" });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  }

  // Real x402 payment via GatewayClient
  try {
    const url = `${SELF_URL()}${endpoint}`;
    const { data, formattedAmount, transaction } = await gatewayClient.pay(url);

    return res.json({
      data,
      service_type,
      amount_paid:  formattedAmount,
      transaction,
      paid_by:      gatewayClient.address,
      x402:         true,
    });
  } catch (err: any) {
    const msg = err?.message || String(err);

    if (msg.includes("insufficient") || msg.includes("balance")) {
      return res.status(402).json({
        error: "insufficient_gateway_balance",
        message: `Fund ${gatewayClient.address} at faucet.circle.com, then: circle gateway deposit --amount 2 --address ${gatewayClient.address} --chain ARC-TESTNET --method direct`,
      });
    }

    return res.status(500).json({ error: msg });
  }
});
