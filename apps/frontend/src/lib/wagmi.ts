import { createConfig, http } from "wagmi";
import { arcTestnet } from "viem/chains";
import { connectorsForWallets } from "@rainbow-me/rainbowkit";
import {
  metaMaskWallet,
  coinbaseWallet,
  walletConnectWallet,
  rainbowWallet,
} from "@rainbow-me/rainbowkit/wallets";

const projectId = import.meta.env.VITE_WC_PROJECT_ID;

const connectors = connectorsForWallets(
  [
    { groupName: "Recommended", wallets: [metaMaskWallet, coinbaseWallet] },
    { groupName: "More", wallets: [walletConnectWallet, rainbowWallet] },
  ],
  {
    appName: "Trident Agent",
    appDescription: "Agentic financial intelligence marketplace on Arc Testnet",
    appUrl: "https://tridentagent.xyz",
    appIcon: "https://tridentagent.xyz/logo.png",
    projectId,
  }
);

export const wagmiConfig = createConfig({
  chains: [arcTestnet],
  connectors,
  transports: {
    [arcTestnet.id]: http(import.meta.env.VITE_ARC_RPC_URL),
  },
});

export { arcTestnet };
