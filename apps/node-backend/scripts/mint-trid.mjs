/**
 * One-time script: mint 100,000 TRID to the buyer agent wallet.
 *
 * Run from apps/node-backend:
 *   DEPLOYER_PRIVATE_KEY=0x... BUYER_AGENT_ADDRESS=0x1bE068... node scripts/mint-trid.mjs
 *
 * Requires: DEPLOYER_PRIVATE_KEY (token owner), TRID contract address.
 * TRID_ADDRESS defaults to the deployed contract — override via env if needed.
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

const TRID_ABI = parseAbi([
  "function mint(address to, uint256 amount) external",
  "function addMinter(address minter) external",
  "function minters(address) view returns (bool)",
  "function balanceOf(address) view returns (uint256)",
  "function owner() view returns (address)",
]);

const DEPLOYER_KEY = process.env.DEPLOYER_PRIVATE_KEY;
const BUYER_AGENT  = process.env.BUYER_AGENT_ADDRESS || "0x1bE068282F1AEdfAC53CdD0385f73365Cfe095D2";
const TRID_ADDRESS = (process.env.TRIDENT_TOKEN_ADDRESS || process.env.VITE_TRIDENT_TOKEN_ADDRESS);

if (!DEPLOYER_KEY) {
  console.error("❌ Set DEPLOYER_PRIVATE_KEY=0x...");
  process.exit(1);
}
if (!TRID_ADDRESS) {
  console.error("❌ Set TRIDENT_TOKEN_ADDRESS=0x...");
  process.exit(1);
}

const key     = DEPLOYER_KEY.startsWith("0x") ? DEPLOYER_KEY : `0x${DEPLOYER_KEY}`;
const account = privateKeyToAccount(key);

const publicClient = createPublicClient({ chain: arcTestnet, transport: http() });
const walletClient = createWalletClient({ account, chain: arcTestnet, transport: http() });

console.log(`Deployer: ${account.address}`);
console.log(`TRID:     ${TRID_ADDRESS}`);
console.log(`Target:   ${BUYER_AGENT}`);

// Verify deployer is owner
const owner = await publicClient.readContract({
  address: TRID_ADDRESS,
  abi: TRID_ABI,
  functionName: "owner",
});
if (owner.toLowerCase() !== account.address.toLowerCase()) {
  console.error(`❌ Deployer is not the token owner (owner is ${owner})`);
  process.exit(1);
}

// Add deployer as minter if not already
const isMinter = await publicClient.readContract({
  address: TRID_ADDRESS,
  abi: TRID_ABI,
  functionName: "minters",
  args: [account.address],
});
if (!isMinter) {
  console.log(`\nAdding deployer as minter...`);
  const addTx = await walletClient.writeContract({
    address: TRID_ADDRESS,
    abi: TRID_ABI,
    functionName: "addMinter",
    args: [account.address],
  });
  await publicClient.waitForTransactionReceipt({ hash: addTx });
  console.log(`✅ Minter added: ${addTx}`);
} else {
  console.log(`✓ Deployer already a minter`);
}

const before = await publicClient.readContract({
  address: TRID_ADDRESS,
  abi: TRID_ABI,
  functionName: "balanceOf",
  args: [BUYER_AGENT],
});
console.log(`\nBuyer agent TRID before: ${Number(before) / 1e6}`);

const AMOUNT = 100_000n * 1_000_000n; // 100,000 TRID (6 decimals)
console.log(`\nMinting 100,000 TRID to ${BUYER_AGENT}...`);
const txHash = await walletClient.writeContract({
  address: TRID_ADDRESS,
  abi: TRID_ABI,
  functionName: "mint",
  args: [BUYER_AGENT, AMOUNT],
});

console.log(`✅ Tx submitted: https://testnet.arcscan.app/tx/${txHash}`);
console.log("Waiting for confirmation...");

await publicClient.waitForTransactionReceipt({ hash: txHash });

const after = await publicClient.readContract({
  address: TRID_ADDRESS,
  abi: TRID_ABI,
  functionName: "balanceOf",
  args: [BUYER_AGENT],
});
console.log(`\nBuyer agent TRID after: ${Number(after) / 1e6} TRID ✓`);
console.log(`ArcScan: https://testnet.arcscan.app/address/${BUYER_AGENT}`);
