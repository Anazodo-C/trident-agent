import { createConfig, http } from "wagmi";
import { defineChain } from "viem";
import { connectorsForWallets } from "@rainbow-me/rainbowkit";
import {
  metaMaskWallet,
  coinbaseWallet,
  walletConnectWallet,
  rainbowWallet,
} from "@rainbow-me/rainbowkit/wallets";

const arcTestnet = defineChain({
  id: 5042002,
  name: "Arc Testnet",
  nativeCurrency: { name: "ARC", symbol: "ARC", decimals: 18 },
  rpcUrls: {
    default: { http: [import.meta.env.VITE_ARC_RPC_URL || "https://rpc.testnet.arc.network"] },
  },
  blockExplorers: {
    default: { name: "ArcScan", url: "https://explorer.testnet.arc.network" },
  },
  testnet: true,
});

const projectId = import.meta.env.VITE_WC_PROJECT_ID || "";

const walletGroups = projectId
  ? [
      { groupName: "Recommended", wallets: [metaMaskWallet, coinbaseWallet] },
      { groupName: "More", wallets: [walletConnectWallet, rainbowWallet] },
    ]
  : [{ groupName: "Recommended", wallets: [metaMaskWallet, coinbaseWallet] }];

const connectors = connectorsForWallets(walletGroups, {
  appName: "Trident Agent",
  appDescription: "Agentic financial intelligence marketplace on Arc Testnet",
  appUrl: "https://trident-agent.vercel.app",
  appIcon: "https://trident-agent.vercel.app/logo.png",
  projectId: projectId || "00000000000000000000000000000000",
});

export const wagmiConfig = createConfig({
  chains: [arcTestnet],
  connectors,
  transports: {
    [arcTestnet.id]: http(import.meta.env.VITE_ARC_RPC_URL),
  },
});

export { arcTestnet };
