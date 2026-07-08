/**
 * Autonomous buyer agent loops using real Circle Gateway x402 payments.
 *
 * Each cycle:
 *   1. Auto-claim TRID from faucet if balance < 5 TRID
 *   2. Auto-deposit USDC into Gateway if balance < 0.10 USDC
 *   3. Make x402 Gateway payment for a random financial data service
 *   4. Mirror the payment on-chain as an ERC-20 TRID transfer (ArcScan visible)
 *   5. Record payment in Python backend for dashboard
 */
import "dotenv/config";
import {
  createPublicClient,
  createWalletClient,
  http,
  parseAbi,
  defineChain,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { gatewayClient, buyerEnabled } from "./gatewayClient.js";
import { isTurbo } from "./turboMode.js";

// 3 agents × 1 tx / ~3 s ≈ 60 tx/min in turbo mode
const TURBO_SLEEP_MS  = () => jitter(2_800,  3_200);
const NORMAL_SLEEP_MS = () => jitter(50 * 60_000, 70 * 60_000);

const PYTHON_API = process.env.PYTHON_API_URL || "http://localhost:8000";
const SELF_URL   = `http://localhost:${process.env.PORT || 3001}`;

// ── Chain + contract addresses ─────────────────────────────────────────────────
const arcTestnet = defineChain({
  id: 5042002,
  name: "Arc Testnet",
  nativeCurrency: { name: "ARC", symbol: "ARC", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.testnet.arc.network"] } },
  blockExplorers: { default: { name: "ArcScan", url: "https://testnet.arcscan.app" } },
});

const TRID_ADDRESS = (
  process.env.TRIDENT_TOKEN_ADDRESS ||
  process.env.VITE_TRIDENT_TOKEN_ADDRESS ||
  "0x5fc8e8b3DC37Bcbb7bC7F013F6a8C56375B40dF7"
) as `0x${string}`;

const FAUCET_ADDRESS = (
  process.env.TRIDENT_FAUCET_ADDRESS ||
  process.env.VITE_TRIDENT_FAUCET_ADDRESS
) as `0x${string}` | undefined;

const SELLER_ADDRESS = (
  process.env.SELLER_ADDRESS || "0x3315ebaab06d6266e92f6063b9360ae10d24F0a0"
) as `0x${string}`;

// ── ABI fragments ──────────────────────────────────────────────────────────────
const ERC20_ABI = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function transfer(address to, uint256 amount) returns (bool)",
]);

const FAUCET_ABI = parseAbi([
  "function claim() external",
  "function canClaim(address) view returns (bool)",
]);

// ── Auto-management thresholds ─────────────────────────────────────────────────
const TRID_CLAIM_THRESHOLD  = 5_000_000n;   // 5 TRID (6 decimals) → auto-claim
const GATEWAY_TOPUP_MIN     = 0.10;          // USDC → trigger auto-deposit
const GATEWAY_TOPUP_AMOUNT  = "1.0";         // USDC to deposit each time

const RPC_URL = "https://rpc.testnet.arc.network";

// ── Viem clients (created once from BUYER_AGENT_PRIVATE_KEY) ──────────────────
const RAW_KEY = process.env.BUYER_AGENT_PRIVATE_KEY;
const buyerAccount = RAW_KEY
  ? privateKeyToAccount((RAW_KEY.startsWith("0x") ? RAW_KEY : `0x${RAW_KEY}`) as `0x${string}`)
  : null;

// Explicit RPC URL — viem doesn't always resolve chain defaults server-side
const publicClient = createPublicClient({ chain: arcTestnet, transport: http(RPC_URL) });
const walletClient = buyerAccount
  ? createWalletClient({ account: buyerAccount, chain: arcTestnet, transport: http(RPC_URL) })
  : null;

// ── Native ARC balance check ───────────────────────────────────────────────────
async function getArcBalance(): Promise<bigint> {
  if (!buyerAccount) return 0n;
  try {
    return await publicClient.getBalance({ address: buyerAccount.address });
  } catch { return 0n; }
}

const MIN_ARC_WEI = 10_000_000_000_000_000n; // 0.01 ARC — enough for ~50 txns

// ── Named buyer personas ───────────────────────────────────────────────────────
const BUYERS = [
  { name: "Alpha Buyer", address: "0xabc4000000000000000000000000000000000004" },
  { name: "Beta Buyer",  address: "0xabc5000000000000000000000000000000000005" },
  { name: "Gamma Buyer", address: "0xabc6000000000000000000000000000000000006" },
];

// Services to buy — each entry includes the matching TRID price for the on-chain mirror
const SERVICE_POOL = [
  { endpoint: "/data/price-feed?symbols=BTC,ETH,USDC,SOL",                          service_type: "price_feed",    price_usdc: "0.001", trid_micro: 1_000n   },
  { endpoint: "/data/fx-rates?base=USD&targets=EUR,GBP,NGN,JPY",                    service_type: "fx_rates",      price_usdc: "0.001", trid_micro: 1_000n   },
  { endpoint: "/data/risk-score?address=0x3315ebaab06d6266e92f6063b9360ae10d24F0a0", service_type: "risk_score",    price_usdc: "0.005", trid_micro: 5_000n   },
  { endpoint: "/data/compute-score?portfolio=BTC:0.4,ETH:0.3,SOL:0.2,USDC:0.1",    service_type: "compute_score", price_usdc: "0.020", trid_micro: 20_000n  },
];

function sleep(ms: number) { return new Promise<void>(r => setTimeout(r, ms)); }
function jitter(min: number, max: number) { return Math.floor(Math.random() * (max - min + 1)) + min; }

/**
 * Interruptible wait — polls every second so toggling turbo mode takes effect
 * within 1 s instead of waiting for the full sleep to expire.
 */
async function waitForNextCycle(): Promise<void> {
  const snapshot = isTurbo();
  const deadline = Date.now() + (snapshot ? TURBO_SLEEP_MS() : NORMAL_SLEEP_MS());
  while (Date.now() < deadline) {
    await sleep(1_000);
    if (isTurbo() !== snapshot) return; // turbo toggled — fire next cycle immediately
  }
}

// ── TRID balance check ─────────────────────────────────────────────────────────
async function getTridBalance(): Promise<bigint> {
  if (!buyerAccount) return 0n;
  try {
    return await publicClient.readContract({
      address: TRID_ADDRESS,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [buyerAccount.address],
    });
  } catch { return 0n; }
}

// ── Auto-claim TRID from faucet ────────────────────────────────────────────────
async function autoClaimTrid(): Promise<void> {
  if (!walletClient || !buyerAccount || !FAUCET_ADDRESS) {
    if (!FAUCET_ADDRESS) console.warn("[BuyerAgent] TRIDENT_FAUCET_ADDRESS not set — skipping auto-claim");
    return;
  }
  try {
    const canClaim = await publicClient.readContract({
      address: FAUCET_ADDRESS,
      abi: FAUCET_ABI,
      functionName: "canClaim",
      args: [buyerAccount.address],
    });
    if (!canClaim) {
      console.log("[BuyerAgent] Auto-claim: faucet cooldown active — will retry next cycle");
      return;
    }
    const txHash = await walletClient.writeContract({
      address: FAUCET_ADDRESS,
      abi: FAUCET_ABI,
      functionName: "claim",
    });
    console.log(`[BuyerAgent] ✅ Auto-claimed TRID from faucet`);
    console.log(`[BuyerAgent]    https://testnet.arcscan.app/tx/${txHash}`);
  } catch (err: any) {
    console.warn(`[BuyerAgent] Auto-claim failed (non-fatal): ${err?.message}`);
  }
}

// ── Auto top-up Circle Gateway USDC ───────────────────────────────────────────
async function autoTopUpGateway(): Promise<boolean> {
  if (!gatewayClient) return false;
  try {
    const bal    = await gatewayClient.getBalances();
    const gwBal  = Number(bal?.gateway?.formattedTotal ?? "0");
    const walBal = Number(bal?.wallet?.formatted ?? "0");

    if (gwBal >= GATEWAY_TOPUP_MIN) return true; // healthy, nothing to do

    if (walBal < Number(GATEWAY_TOPUP_AMOUNT)) {
      console.warn(
        `[BuyerAgent] Gateway low (${gwBal} USDC) but wallet also low (${walBal} USDC).\n` +
        `   Fund ${gatewayClient.address} at https://faucet.circle.com`
      );
      return false;
    }

    console.log(`[BuyerAgent] Gateway low (${gwBal} USDC) — auto-depositing ${GATEWAY_TOPUP_AMOUNT} USDC`);
    await gatewayClient.deposit(GATEWAY_TOPUP_AMOUNT as any);
    console.log(`[BuyerAgent] ✅ Auto-deposited ${GATEWAY_TOPUP_AMOUNT} USDC into Circle Gateway`);
    await sleep(5_000); // brief settle
    return true;
  } catch (err: any) {
    console.warn(`[BuyerAgent] Auto top-up failed (non-fatal): ${err?.message}`);
    return false;
  }
}

// ── On-chain TRID mirror ───────────────────────────────────────────────────────
// Every x402 Gateway payment is mirrored as an ERC-20 TRID transfer so it's
// visible on ArcScan and verifiable by hackathon judges.
async function sendTridMirror(tridAmount: bigint, serviceName: string): Promise<void> {
  if (!walletClient || !buyerAccount) return;

  // Gate on native ARC balance — ERC-20 transfers still cost gas
  const arcBal = await getArcBalance();
  if (arcBal < MIN_ARC_WEI) {
    console.warn(
      `[BuyerAgent] TRID mirror skipped — insufficient ARC for gas.\n` +
      `   Buyer wallet: ${buyerAccount.address}\n` +
      `   ARC balance:  ${Number(arcBal) / 1e18} ARC\n` +
      `   Get ARC at:   https://faucet.testnet.arc.network`
    );
    return;
  }

  try {
    const txHash = await walletClient.writeContract({
      address:      TRID_ADDRESS,
      abi:          ERC20_ABI,
      functionName: "transfer",
      args:         [SELLER_ADDRESS, tridAmount],
      chain:        arcTestnet,
      account:      buyerAccount,
    });
    console.log(`[BuyerAgent] ⛓ TRID mirror (${serviceName}): ${(Number(tridAmount) / 1_000_000).toFixed(4)} TRID → seller`);
    console.log(`[BuyerAgent]    https://testnet.arcscan.app/tx/${txHash}`);
  } catch (err: any) {
    // Log full error so we can diagnose RPC vs contract vs balance issues
    const detail = err?.cause?.message ?? err?.shortMessage ?? err?.message ?? String(err);
    console.warn(`[BuyerAgent] TRID mirror failed (non-fatal): ${detail}`);
    console.warn(`[BuyerAgent]   contract: ${TRID_ADDRESS} | to: ${SELLER_ADDRESS} | amount: ${tridAmount}`);
  }
}

// ── Record payment in Python dashboard ────────────────────────────────────────
async function recordPayment(
  buyer: { name: string; address: string },
  service_type: string,
  amount_usdc: string,
  tx_ref: string
) {
  try {
    await fetch(`${PYTHON_API}/api/internal/record-payment`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        buyer_address:  buyer.address,
        buyer_name:     buyer.name,
        seller_address: SELLER_ADDRESS,
        service_type,
        amount_usdc,
        tx_ref,
        source: "circle_gateway_x402",
      }),
      signal: AbortSignal.timeout(5000),
    });
  } catch (e: any) {
    console.warn(`[BuyerAgent] record-payment failed (non-fatal): ${e.message}`);
  }
}

// ── Single purchase ────────────────────────────────────────────────────────────
async function buyOnce(buyer: (typeof BUYERS)[0]) {
  if (!gatewayClient || !buyerEnabled) return;

  const svc = SERVICE_POOL[Math.floor(Math.random() * SERVICE_POOL.length)];
  const url  = `${SELF_URL}${svc.endpoint}`;

  try {
    const { formattedAmount, transaction } = await gatewayClient.pay(url);
    console.log(`[BuyerAgent] ${buyer.name} paid ${formattedAmount} USDC → ${svc.service_type} ✓`);

    // Fire TRID mirror on-chain (non-blocking)
    sendTridMirror(svc.trid_micro, svc.service_type).catch(() => {});

    // Record in dashboard
    await recordPayment(buyer, svc.service_type, formattedAmount, transaction);
  } catch (err: any) {
    const msg = err?.message || String(err);
    if (msg.includes("insufficient") || msg.includes("balance")) {
      console.warn(`[BuyerAgent] ${buyer.name}: insufficient Gateway balance — triggering top-up`);
      await autoTopUpGateway();
    } else {
      console.warn(`[BuyerAgent] ${buyer.name} payment failed: ${msg}`);
    }
  }
}

// ── Main loop ──────────────────────────────────────────────────────────────────
async function buyerLoop(buyer: (typeof BUYERS)[0], initialDelay: number) {
  await sleep(initialDelay);

  while (true) {
    // 1. Check TRID balance → auto-claim if < 5 TRID
    const tridBal = await getTridBalance();
    if (tridBal < TRID_CLAIM_THRESHOLD) {
      console.log(
        `[BuyerAgent] ${buyer.name}: TRID balance ${(Number(tridBal) / 1_000_000).toFixed(4)} < 5 — auto-claiming`
      );
      await autoClaimTrid();
    }

    // 2. Auto top-up Gateway USDC if low
    const gwHealthy = await autoTopUpGateway();
    if (!gwHealthy) {
      console.warn("[BuyerAgent] Gateway balance critically low — pausing 10 min");
      await sleep(10 * 60_000);
      continue;
    }

    // 3. Make the x402 purchase (+ fires TRID mirror on-chain)
    await buyOnce(buyer);

    // 4. Interruptible wait — wakes within 1 s if turbo is toggled
    await waitForNextCycle();
  }
}

/** Start all buyer agent loops as background tasks. */
export function startBuyerAgents() {
  if (!buyerEnabled) {
    console.log("ℹ️  Buyer agents disabled (no BUYER_AGENT_PRIVATE_KEY). Dashboard will show Python sim only.");
    return;
  }

  console.log(`🤖 Starting ${BUYERS.length} Circle Gateway buyer agents...`);
  console.log(`   TRID mirror → ${SELLER_ADDRESS}`);
  console.log(`   Auto-claim threshold: 5 TRID | Auto top-up threshold: ${GATEWAY_TOPUP_MIN} USDC`);
  console.log(`   TRID contract: ${TRID_ADDRESS}`);
  if (buyerAccount) {
    // Log ARC balance at startup so gas issues are immediately visible in logs
    getArcBalance().then(arc => {
      const arcEth = Number(arc) / 1e18;
      if (arc < MIN_ARC_WEI) {
        console.warn(
          `⚠️  Buyer agent wallet has ${arcEth} ARC — too low for gas.\n` +
          `   Get ARC at: https://faucet.testnet.arc.network\n` +
          `   Wallet:     ${buyerAccount!.address}`
        );
      } else {
        console.log(`   ARC gas balance: ${arcEth} ARC ✓`);
      }
    }).catch(() => {});
  }

  BUYERS.forEach((buyer, i) => {
    const delay = jitter(10_000, 30_000) * (i + 1);
    buyerLoop(buyer, delay).catch(e =>
      console.error(`[BuyerAgent] ${buyer.name} loop crashed:`, e)
    );
  });
}
