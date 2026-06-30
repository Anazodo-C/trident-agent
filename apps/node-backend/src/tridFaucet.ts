/**
 * TRID Faucet — buyer agent claims 10 TRID/hour from TridentFaucet contract.
 * Runs on startup and every 60 min thereafter.
 * This gives buyer agents real TRID balance for on-chain payments.
 */
import { createWalletClient, createPublicClient, http, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { defineChain } from "viem";

const arcTestnet = defineChain({
  id: 5042002,
  name: "Arc Testnet",
  nativeCurrency: { name: "ARC", symbol: "ARC", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.testnet.arc.network"] } },
  blockExplorers: { default: { name: "ArcScan", url: "https://testnet.arcscan.app" } },
});

const FAUCET_ABI = parseAbi([
  "function claim() external",
  "function canClaim(address) view returns (bool)",
  "function lastClaim(address) view returns (uint256)",
]);

const FAUCET_ADDRESS = (process.env.VITE_TRIDENT_FAUCET_ADDRESS ||
  process.env.TRIDENT_FAUCET_ADDRESS) as `0x${string}` | undefined;

const CLAIM_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const BUYER_AGENT_PRIVATE_KEY = process.env.BUYER_AGENT_PRIVATE_KEY;

async function claimFaucet(): Promise<void> {
  if (!BUYER_AGENT_PRIVATE_KEY || !FAUCET_ADDRESS) {
    console.log("[TridFaucet] Skipping — BUYER_AGENT_PRIVATE_KEY or faucet address not set");
    return;
  }

  const key = BUYER_AGENT_PRIVATE_KEY.startsWith("0x")
    ? (BUYER_AGENT_PRIVATE_KEY as `0x${string}`)
    : (`0x${BUYER_AGENT_PRIVATE_KEY}` as `0x${string}`);

  const account = privateKeyToAccount(key);

  const publicClient = createPublicClient({ chain: arcTestnet, transport: http() });
  const walletClient = createWalletClient({ account, chain: arcTestnet, transport: http() });

  try {
    const eligible = await publicClient.readContract({
      address: FAUCET_ADDRESS,
      abi: FAUCET_ABI,
      functionName: "canClaim",
      args: [account.address],
    });

    if (!eligible) {
      console.log(`[TridFaucet] ${account.address.slice(0, 8)}... not yet eligible (cooldown active)`);
      return;
    }

    const txHash = await walletClient.writeContract({
      address: FAUCET_ADDRESS,
      abi: FAUCET_ABI,
      functionName: "claim",
    });

    console.log(`[TridFaucet] ✅ Claimed 10 TRID for buyer agent ${account.address.slice(0, 8)}...`);
    console.log(`[TridFaucet]    Tx: https://testnet.arcscan.app/tx/${txHash}`);
  } catch (err: any) {
    console.warn(`[TridFaucet] Claim failed (non-fatal): ${err?.message ?? err}`);
  }
}

/** Start periodic TRID faucet claims for the buyer agent wallet. */
export function startTridFaucetLoop(): void {
  if (!BUYER_AGENT_PRIVATE_KEY) {
    console.log("[TridFaucet] BUYER_AGENT_PRIVATE_KEY not set — skipping faucet loop");
    return;
  }
  if (!FAUCET_ADDRESS) {
    console.log("[TridFaucet] Faucet address not set (TRIDENT_FAUCET_ADDRESS) — skipping");
    return;
  }

  // First claim after 30s (let server settle)
  setTimeout(async () => {
    await claimFaucet();
    // Then every hour
    setInterval(claimFaucet, CLAIM_INTERVAL_MS);
  }, 30_000);

  console.log(`[TridFaucet] Scheduled: claim 10 TRID every 60 min from ${FAUCET_ADDRESS}`);
}
