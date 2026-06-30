import { useEffect, useState } from "react";
import { useAccount, useBalance, useReadContract } from "wagmi";
import { formatUnits } from "viem";

const TRID_ADDRESS = (import.meta.env.VITE_TRIDENT_TOKEN_ADDRESS ||
  "0x5fc8e8b3DC37Bcbb7bC7F013F6a8C56375B40dF7") as `0x${string}`;

const ERC20_BALANCE_ABI = [
  {
    name: "balanceOf",
    type: "function",
    stateMutability: "view",
    inputs:  [{ name: "account", type: "address" }],
    outputs: [{ name: "",        type: "uint256"  }],
  },
] as const;

export interface WalletBalances {
  trid:      string; // e.g. "10.000000"
  tridRaw:   bigint;
  native:    string; // ETH/USDC on Arc (gas token)
  nativeRaw: bigint;
  loading:   boolean;
  error:     string | null;
  refetch:   () => void;
}

export function useWalletBalance(): WalletBalances {
  const { address, isConnected } = useAccount();
  const [error, setError] = useState<string | null>(null);

  // Native balance (Arc uses USDC as gas)
  const {
    data: nativeBal,
    isLoading: nativeLoading,
    refetch: refetchNative,
  } = useBalance({ address, query: { enabled: isConnected && !!address } });

  // $TRID ERC-20 balance
  const {
    data: tridRaw,
    isLoading: tridLoading,
    refetch: refetchTrid,
  } = useReadContract({
    address:      TRID_ADDRESS,
    abi:          ERC20_BALANCE_ABI,
    functionName: "balanceOf",
    args:         address ? [address] : undefined,
    query:        { enabled: isConnected && !!address },
  });

  const tridBigint = (tridRaw as bigint | undefined) ?? 0n;
  const nativeBigint = nativeBal?.value ?? 0n;

  // Format TRID: 6 decimals
  const tridFormatted = formatUnits(tridBigint, 6);
  // Format native: 18 decimals → show up to 4 decimals
  const nativeFormatted = parseFloat(formatUnits(nativeBigint, 18)).toFixed(4);

  const refetch = () => {
    refetchNative();
    refetchTrid();
  };

  useEffect(() => {
    setError(null);
  }, [address]);

  return {
    trid:      tridFormatted,
    tridRaw:   tridBigint,
    native:    nativeFormatted,
    nativeRaw: nativeBigint,
    loading:   nativeLoading || tridLoading,
    error,
    refetch,
  };
}
