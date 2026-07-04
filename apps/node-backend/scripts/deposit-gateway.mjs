/**
 * One-time script: deposit USDC into Circle Gateway for the buyer agent wallet.
 * Run from apps/node-backend:
 *   BUYER_AGENT_PRIVATE_KEY=0x... node scripts/deposit-gateway.mjs
 */
import { GatewayClient } from "@circle-fin/x402-batching/client";

const key = process.env.BUYER_AGENT_PRIVATE_KEY;
if (!key) {
  console.error("Set BUYER_AGENT_PRIVATE_KEY=0x... before running");
  process.exit(1);
}

const client = new GatewayClient({
  chain: "arcTestnet",
  privateKey: key.startsWith("0x") ? key : `0x${key}`,
  rpcUrl: "https://rpc.testnet.arc.network",
});

console.log(`Wallet:  ${client.address}`);

const balances = await client.getBalances();
console.log(`USDC balance:    ${balances.wallet.formatted} USDC`);
console.log(`Gateway balance: ${balances.gateway.formattedTotal} USDC`);

if (balances.wallet.balance === 0n) {
  console.error("\n❌ Wallet has no USDC. Fund it first at https://faucet.circle.com (Arc Testnet)");
  process.exit(1);
}

console.log("\nDepositing 5 USDC into Circle Gateway...");
const result = await client.deposit("5");
console.log(`✅ Deposited ${result.formattedAmount} USDC`);
console.log(`   Tx: ${result.depositTxHash}`);

const after = await client.getBalances();
console.log(`\nGateway balance now: ${after.gateway.formattedTotal} USDC`);
