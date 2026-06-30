/**
 * Singleton GatewayClient for Circle Gateway x402 payments.
 *
 * Used by:
 *  - buyerAgents.ts  → background loops making real x402 purchases
 *  - routes/hire.ts  → frontend-triggered x402 payments
 *
 * The private key is stored in BUYER_AGENT_PRIVATE_KEY (Railway env var).
 * On first startup, this module prints the derived wallet address so you
 * can fund it with testnet USDC via the Circle faucet.
 */
import { GatewayClient } from "@circle-fin/x402-batching/client";
import "dotenv/config";

const RPC_URL = "https://rpc.testnet.arc.network";

function createClient(): GatewayClient | null {
  const key = process.env.BUYER_AGENT_PRIVATE_KEY;
  if (!key) {
    console.warn(
      "⚠️  BUYER_AGENT_PRIVATE_KEY not set — x402 buyer agents disabled.\n" +
      "   Generate one: openssl rand -hex 32 (prefix with 0x)\n" +
      "   Fund via:     faucet.circle.com → select Arc Testnet → paste address\n" +
      "   Then add to Railway env vars and redeploy."
    );
    return null;
  }

  const privateKey = (key.startsWith("0x") ? key : `0x${key}`) as `0x${string}`;

  const client = new GatewayClient({
    chain: "arcTestnet",
    privateKey,
    rpcUrl: RPC_URL,
  });

  console.log(`🔑 Buyer agent wallet: ${client.address}`);
  console.log(`   Chain: Arc Testnet (eip155:5042002)`);
  console.log(`   Fund this address at: https://faucet.circle.com`);
  console.log(`   Then deposit into Gateway so x402 payments work.`);

  return client;
}

export const gatewayClient = createClient();

/** True when the buyer agent has a funded GatewayClient ready. */
export const buyerEnabled = gatewayClient !== null;
