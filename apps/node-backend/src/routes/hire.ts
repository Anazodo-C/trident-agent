/**
 * POST /hire
 *
 * Frontend-triggered x402 payment. Supports two modes:
 *
 *  A) Per-user payment (preferred): agent_private_key provided in body
 *     → creates a one-shot GatewayClient for that user's wallet
 *     → payment comes from the user's own Circle Gateway balance
 *
 *  B) Shared buyer agent fallback: no agent_private_key
 *     → uses the shared BUYER_AGENT_PRIVATE_KEY GatewayClient
 *     → payment comes from the platform's shared gateway balance
 *
 * Request body:
 *   {
 *     service_type:      string
 *     params?:           Record<string,string>
 *     buyer_address?:    string
 *     agent_private_key?: string   // hex, with or without 0x prefix
 *   }
 *
 * NOTE: agent_private_key is only transmitted over HTTPS and is never logged
 * or persisted — it is used solely to create the one-shot GatewayClient
 * for this request and then discarded.
 */
import { Router } from "express";
import { GatewayClient } from "@circle-fin/x402-batching/client";
import { gatewayClient, buyerEnabled } from "../gatewayClient.js";

export const hireRouter = Router();

const RPC_URL = "https://rpc.testnet.arc.network";

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

/** Create a one-shot GatewayClient for a user-supplied private key. */
function userClient(privateKeyRaw: string): GatewayClient {
  const pk = (privateKeyRaw.startsWith("0x") ? privateKeyRaw : `0x${privateKeyRaw}`) as `0x${string}`;
  return new GatewayClient({ chain: "arcTestnet", privateKey: pk, rpcUrl: RPC_URL });
}

hireRouter.post("/", async (req, res) => {
  const {
    service_type,
    params = {},
    buyer_address,
    agent_private_key,
  } = req.body as {
    service_type: string;
    params?: Record<string, string>;
    buyer_address?: string;
    agent_private_key?: string;
  };

  if (!service_type) {
    return res.status(400).json({ error: "service_type is required" });
  }

  // Resolve which GatewayClient to use: per-user key takes priority
  let client: GatewayClient | null = null;
  let paymentSource: "user_agent" | "shared_agent" | "none" = "none";

  if (agent_private_key) {
    try {
      client = userClient(agent_private_key);
      paymentSource = "user_agent";
    } catch (err: any) {
      return res.status(400).json({ error: `Invalid agent_private_key: ${err.message}` });
    }
  } else if (buyerEnabled && gatewayClient) {
    client = gatewayClient;
    paymentSource = "shared_agent";
  }

  console.log(`[Hire] ${service_type} | source=${paymentSource} | buyer=${buyer_address?.slice(0,10) ?? "anon"}`);

  // ── Retrobot audit: POST to /retrobot/audit with x402 ──
  if (service_type === "retrobot_audit") {
    if (!client) {
      return res.status(402).json({
        error: "x402_not_configured",
        message: "Unlock your agent (enter passphrase) or set BUYER_AGENT_PRIVATE_KEY in Railway.",
      });
    }
    try {
      console.log(`[Hire] → x402 POST /retrobot/audit | payer=${client.address}`);
      const { data, formattedAmount, transaction } = await client.pay(
        `${SELF_URL()}/retrobot/audit`,
        {
          method: "POST",
          body: { wallet_address: buyer_address || "0x0000000000000000000000000000000000000001" },
        }
      );
      console.log(`[Hire] ✅ retrobot_audit paid ${formattedAmount} USDC | tx=${transaction}`);
      return res.json({
        data,
        service_type,
        amount_paid: formattedAmount,
        transaction,
        paid_by: client.address,
        payment_source: paymentSource,
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

  // No GatewayClient at all — direct call (no payment)
  if (!client) {
    try {
      const r = await fetch(`${SELF_URL()}${endpoint}`, { signal: AbortSignal.timeout(10000) });
      if (r.status === 402) {
        return res.status(402).json({
          error: "x402_payment_required",
          message: "Unlock your agent (enter passphrase in My Agent panel) to pay from your own Gateway balance.",
          endpoint,
        });
      }
      const data = await r.json();
      return res.json({
        data,
        service_type,
        amount_paid: null,
        x402: false,
        note: "No Gateway client configured — data returned without payment",
      });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  }

  // Real x402 payment
  try {
    const url = `${SELF_URL()}${endpoint}`;
    console.log(`[Hire] → x402 GET ${url} | payer=${client.address}`);
    const { data, formattedAmount, transaction } = await client.pay(url);
    console.log(`[Hire] ✅ paid ${formattedAmount} USDC | tx=${transaction} | source=${paymentSource}`);

    return res.json({
      data,
      service_type,
      amount_paid:    formattedAmount,
      transaction,
      paid_by:        client.address,
      payment_source: paymentSource,
      x402:           true,
    });
  } catch (err: any) {
    const msg = err?.message || String(err);
    console.warn(`[Hire] ❌ ${service_type} failed (${paymentSource}): ${msg}`);

    if (msg.includes("insufficient") || msg.includes("balance") || msg.includes("not enough")) {
      const hint = paymentSource === "user_agent"
        ? "Your agent wallet needs USDC. Use the 💧 Fund button in My Agent panel: get USDC from faucet.circle.com then deposit to Gateway."
        : `Fund ${client.address} at faucet.circle.com and deposit to Gateway.`;
      return res.status(402).json({
        error: "insufficient_gateway_balance",
        message: hint,
        paid_by: client.address,
        payment_source: paymentSource,
      });
    }

    return res.status(500).json({ error: msg });
  }
});
