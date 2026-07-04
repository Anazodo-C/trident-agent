/**
 * Autonomous buyer agent loops using real Circle Gateway x402 payments.
 *
 * Each "buyer" is a named persona that periodically purchases financial
 * data services via gateway.pay(). The actual payment is:
 *   1. GET /data/price-feed  → Node backend returns 402
 *   2. GatewayClient signs EIP-3009 (GatewayWalletBatched, zero gas)
 *   3. Retries with PAYMENT-SIGNATURE header
 *   4. Node backend verifies via Circle Gateway facilitator → returns data
 *   5. We POST /api/internal/record-payment to Python backend for dashboard
 */
import "dotenv/config";
import { gatewayClient, buyerEnabled } from "./gatewayClient.js";

const PYTHON_API = process.env.PYTHON_API_URL || "http://localhost:8000";
const SELF_URL   = `http://localhost:${process.env.PORT || 3001}`;

// Named buyer personas — share one GatewayClient (one wallet) but have
// distinct display names / addresses for the marketplace dashboard.
const BUYERS = [
  {
    name: "Alpha Buyer",
    address: "0xabc4000000000000000000000000000000000004",
  },
  {
    name: "Beta Buyer",
    address: "0xabc5000000000000000000000000000000000005",
  },
  {
    name: "Gamma Buyer",
    address: "0xabc6000000000000000000000000000000000006",
  },
];

// Services to buy — vary by buyer so calls look organic
const SERVICE_POOL = [
  { endpoint: "/data/price-feed?symbols=BTC,ETH,USDC,SOL", service_type: "price_feed",    price: "0.001" },
  { endpoint: "/data/fx-rates?base=USD&targets=EUR,GBP,NGN,JPY", service_type: "fx_rates",     price: "0.001" },
  { endpoint: "/data/risk-score?address=0x3315ebaab06d6266e92f6063b9360ae10d24F0a0", service_type: "risk_score",   price: "0.005" },
  { endpoint: "/data/compute-score?portfolio=BTC:0.4,ETH:0.3,SOL:0.2,USDC:0.1", service_type: "compute_score", price: "0.020" },
];

function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

function jitter(min: number, max: number) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

async function recordPayment(
  buyer: { name: string; address: string },
  service_type: string,
  amount_usdc: string,
  tx_ref: string
) {
  try {
    const body = JSON.stringify({
      buyer_address:   buyer.address,
      buyer_name:      buyer.name,
      seller_address:  process.env.SELLER_ADDRESS || "0x3315ebaab06d6266e92f6063b9360ae10d24F0a0",
      service_type,
      amount_usdc,
      tx_ref,
      source:          "circle_gateway_x402",
    });

    const r = await fetch(`${PYTHON_API}/api/internal/record-payment`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      signal: AbortSignal.timeout(5000),
    });

    if (!r.ok) {
      console.warn(`[BuyerAgent] record-payment HTTP ${r.status}`);
    }
  } catch (e: any) {
    // Non-fatal — dashboard just won't show this payment immediately
    console.warn(`[BuyerAgent] record-payment failed (non-fatal): ${e.message}`);
  }
}

async function buyOnce(buyer: (typeof BUYERS)[0]) {
  if (!gatewayClient || !buyerEnabled) return;

  const svc = SERVICE_POOL[Math.floor(Math.random() * SERVICE_POOL.length)];
  const url  = `${SELF_URL}${svc.endpoint}`;

  try {
    const { data, formattedAmount, transaction } = await gatewayClient.pay(url);
    console.log(
      `[BuyerAgent] ${buyer.name} paid ${formattedAmount} USDC → ${svc.service_type} ✓`
    );
    await recordPayment(buyer, svc.service_type, formattedAmount, transaction);
    return data;
  } catch (err: any) {
    const msg = err?.message || String(err);
    // Insufficient Gateway balance → print helpful hint, back off
    if (msg.includes("insufficient") || msg.includes("balance")) {
      console.warn(
        `[BuyerAgent] ${buyer.name}: insufficient Gateway balance.\n` +
        `   Run: circle gateway deposit --amount 2 --address ${gatewayClient.address} --chain ARC-TESTNET --method direct\n` +
        `   Or visit: https://faucet.circle.com`
      );
    } else {
      console.warn(`[BuyerAgent] ${buyer.name} payment failed: ${msg}`);
    }
  }
}

async function checkGatewayBalance(): Promise<number> {
  try {
    const balances = await gatewayClient!.getBalances();
    return Number(balances.gateway.formattedTotal ?? "0");
  } catch {
    return 0;
  }
}

async function buyerLoop(buyer: (typeof BUYERS)[0], initialDelay: number) {
  await sleep(initialDelay);
  while (true) {
    // Skip buy if Gateway balance is critically low — preserve for manual /hire calls
    const gwBalance = await checkGatewayBalance();
    if (gwBalance < 0.05) {
      console.warn(
        `[BuyerAgent] Gateway balance low (${gwBalance} USDC) — pausing auto-buys.\n` +
        `   Refill: re-run scripts/deposit-gateway.mjs after funding ${gatewayClient!.address} at faucet.circle.com`
      );
      await sleep(10 * 60_000); // check again in 10 min
      continue;
    }
    await buyOnce(buyer);
    await sleep(jitter(50 * 60_000, 70 * 60_000)); // ~1 call per hour per buyer
  }
}

/** Start all buyer agent loops as background tasks. */
export function startBuyerAgents() {
  if (!buyerEnabled) {
    console.log("ℹ️  Buyer agents disabled (no BUYER_AGENT_PRIVATE_KEY). Dashboard will show Python sim only.");
    return;
  }

  console.log(`🤖 Starting ${BUYERS.length} Circle Gateway buyer agents...`);
  BUYERS.forEach((buyer, i) => {
    // Stagger startup by 10–30s so they don't all fire at once
    const delay = jitter(10_000, 30_000) * (i + 1);
    buyerLoop(buyer, delay).catch((e) =>
      console.error(`[BuyerAgent] ${buyer.name} loop crashed:`, e)
    );
  });
}
