import { useEffect, useState } from "react";
import { useAccount, useWriteContract, useWaitForTransactionReceipt, useReadContract } from "wagmi";
import { useToast } from "./Toast";

const FAUCET_ADDRESS = "0x0010148d7b7eEC8a0754d48E7Af2E8Ba68bF9905" as const;
const ARC_SCAN      = "https://testnet.arcscan.app/tx/";

const FAUCET_ABI = [
  {
    name: "claim",
    type: "function",
    stateMutability: "nonpayable",
    inputs:  [],
    outputs: [],
  },
  {
    name: "canClaim",
    type: "function",
    stateMutability: "view",
    inputs:  [{ name: "agent", type: "address" }],
    outputs: [
      { name: "eligible",         type: "bool"    },
      { name: "secondsRemaining", type: "uint256" },
    ],
  },
] as const;

interface Props {
  onAccept: () => void;
  onSkip:   () => void;
}

function fmt(secs: bigint): string {
  const m = Number(secs) / 60;
  return m < 2 ? `${Number(secs)}s` : `${Math.ceil(m)}m`;
}

export default function FaucetModal({ onAccept, onSkip }: Props) {
  const { address, isConnected } = useAccount();
  const { show }                 = useToast();
  const [done, setDone]          = useState(false);

  // Check on-chain eligibility
  const { data: eligibility, isLoading: checking } = useReadContract({
    address:      FAUCET_ADDRESS,
    abi:          FAUCET_ABI,
    functionName: "canClaim",
    args:         address ? [address] : undefined,
    query:        { enabled: isConnected && !!address, refetchInterval: 5000 },
  });

  const eligible  = eligibility ? (eligibility as [boolean, bigint])[0] : false;
  const remaining = eligibility ? (eligibility as [boolean, bigint])[1] : 0n;

  // Write: claim()
  const { writeContract, data: txHash, isPending, error: writeError } = useWriteContract();

  // Wait for confirmation
  const { isLoading: confirming, isSuccess } = useWaitForTransactionReceipt({
    hash: txHash,
  });

  // Success side-effect
  useEffect(() => {
    if (isSuccess && !done) {
      setDone(true);
      show("10 TRID claimed on Arc Testnet! 🎉", "success", 5000);
    }
  }, [isSuccess, done, show]);

  // Write error side-effect
  useEffect(() => {
    if (writeError) {
      const msg = (writeError as Error).message?.slice(0, 120) || "Transaction failed";
      show(msg, "error", 5000);
    }
  }, [writeError, show]);

  const handleClaim = () => {
    writeContract({
      address:      FAUCET_ADDRESS,
      abi:          FAUCET_ABI,
      functionName: "claim",
    });
  };

  const busy = isPending || confirming;

  return (
    <div className="modal-overlay">
      <div className="modal-box p-7">
        {/* Header */}
        <div className="flex items-center gap-3 mb-5">
          <div
            className="w-12 h-12 rounded-2xl flex items-center justify-center text-2xl shrink-0"
            style={{ background: "rgba(0,180,216,0.15)", border: "1.5px solid rgba(0,180,216,0.3)" }}
          >
            💧
          </div>
          <div>
            <h2 className="font-bold text-lg" style={{ color: "var(--text-primary)" }}>
              {done ? "TRID Claimed!" : "Claim $TRID from Faucet"}
            </h2>
            <p className="text-xs mt-0.5" style={{ color: "var(--text-muted)" }}>
              {done ? "10 TRID arrived in your wallet" : "Free tokens to hire agents on Arc Testnet"}
            </p>
          </div>
        </div>

        {/* Reward box */}
        <div
          className="rounded-xl p-4 mb-6 text-center"
          style={{ background: "rgba(0,180,216,0.08)", border: "1px solid rgba(0,180,216,0.2)" }}
        >
          <div className="text-4xl font-bold mb-1" style={{ color: "var(--accent)" }}>
            10 TRID
          </div>
          <div className="text-xs" style={{ color: "var(--text-muted)" }}>
            Minted on-chain via TridentFaucet · 1h cooldown
          </div>
          {address && (
            <div className="text-xs mt-2 mono opacity-60" style={{ color: "var(--text-muted)" }}>
              {address.slice(0, 8)}…{address.slice(-6)}
            </div>
          )}
        </div>

        {/* State: success */}
        {done ? (
          <div className="space-y-3">
            <div className="flex items-center justify-center gap-2 py-2">
              <span className="text-xl">✅</span>
              <span className="font-semibold" style={{ color: "#10b981" }}>
                10 TRID sent to your wallet
              </span>
            </div>
            {txHash && (
              <a
                href={`${ARC_SCAN}${txHash}`}
                target="_blank"
                rel="noopener noreferrer"
                className="block text-center text-xs underline"
                style={{ color: "var(--text-muted)" }}
              >
                View transaction on ArcScan ↗
              </a>
            )}
            <button onClick={onAccept} className="btn-primary w-full mt-1">
              Start Hiring Agents →
            </button>
          </div>
        ) : checking ? (
          <div className="text-center py-3 text-sm" style={{ color: "var(--text-muted)" }}>
            Checking eligibility…
          </div>
        ) : !eligible && remaining > 0n ? (
          /* On cooldown */
          <div className="space-y-3">
            <div
              className="rounded-xl p-3 text-center text-sm"
              style={{ background: "rgba(245,158,11,0.1)", border: "1px solid rgba(245,158,11,0.3)", color: "#f59e0b" }}
            >
              ⏱ Cooldown: {fmt(remaining)} remaining
            </div>
            <button onClick={onSkip} className="btn-secondary w-full">
              Skip — I'll claim later
            </button>
          </div>
        ) : (
          /* Ready to claim */
          <div className="space-y-3">
            {/* Pending tx status */}
            {txHash && confirming && (
              <div
                className="rounded-xl p-3 text-center text-xs mono"
                style={{ background: "rgba(0,180,216,0.07)", border: "1px solid rgba(0,180,216,0.2)", color: "var(--text-muted)" }}
              >
                ⏳ Confirming… {txHash.slice(0, 10)}…
              </div>
            )}

            <div className="flex gap-3">
              <button
                onClick={handleClaim}
                disabled={busy || !isConnected}
                className="btn-primary flex-1"
              >
                {isPending   ? "Confirm in wallet…" :
                 confirming  ? "Confirming on-chain…" :
                 "Claim 10 TRID"}
              </button>
              <button onClick={onSkip} className="btn-secondary">
                Skip
              </button>
            </div>

            <p className="text-xs text-center opacity-50" style={{ color: "var(--text-muted)" }}>
              Real on-chain mint · Arc Testnet · No gas needed
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
