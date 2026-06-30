import { useState } from "react";
import { useAccount } from "wagmi";
import axios from "axios";
import { useToast } from "./Toast";

const API = import.meta.env.VITE_API_URL || "http://localhost:8000";

interface Props {
  onAccept: () => void;
  onSkip:   () => void;
}

export default function FaucetModal({ onAccept, onSkip }: Props) {
  const { address } = useAccount();
  const { show, dismiss } = useToast();
  const [claiming, setClaiming] = useState(false);
  const [claimed, setClaimed] = useState(false);

  const handleClaim = async () => {
    if (!address) return;
    setClaiming(true);
    const tid = show("Claiming TRID from faucet…", "loading");
    try {
      const res = await axios.post(`${API}/api/faucet/claim`, { wallet: address });
      dismiss(tid);
      setClaimed(true);
      show(
        res.data?.message || `10 TRID sent to your wallet!`,
        "success",
        4000,
      );
      setTimeout(onAccept, 1400);
    } catch (e: any) {
      dismiss(tid);
      const msg = e?.response?.data?.detail || "Faucet unavailable — try again later";
      show(msg, "error", 4000);
      setClaiming(false);
    }
  };

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
              Wallet connected!
            </h2>
            <p className="text-sm" style={{ color: "var(--text-muted)" }}>
              Claim free $TRID to start using agents
            </p>
          </div>
        </div>

        {/* Reward box */}
        <div
          className="rounded-xl p-4 mb-6 text-center"
          style={{
            background: "rgba(0,180,216,0.08)",
            border: "1px solid rgba(0,180,216,0.2)",
          }}
        >
          <div className="text-4xl font-bold mb-1" style={{ color: "var(--accent)" }}>
            10 TRID
          </div>
          <div className="text-sm" style={{ color: "var(--text-muted)" }}>
            Free trial tokens — no strings attached
          </div>
          <div className="text-xs mt-2 font-mono opacity-60" style={{ color: "var(--text-muted)" }}>
            {address?.slice(0, 6)}…{address?.slice(-4)}
          </div>
        </div>

        {/* Actions */}
        {claimed ? (
          <div className="flex items-center justify-center gap-2 py-2">
            <span className="text-emerald-500 text-xl">✅</span>
            <span className="font-semibold" style={{ color: "var(--accent)" }}>
              TRID sent to your wallet
            </span>
          </div>
        ) : (
          <div className="flex gap-3">
            <button
              onClick={handleClaim}
              disabled={claiming}
              className="btn-primary flex-1"
            >
              {claiming ? "Claiming…" : "Claim 10 TRID"}
            </button>
            <button onClick={onSkip} className="btn-secondary">
              Skip
            </button>
          </div>
        )}

        <p className="text-xs text-center mt-4 opacity-50" style={{ color: "var(--text-muted)" }}>
          $TRID is a test token on Arc Testnet. No real value.
        </p>
      </div>
    </div>
  );
}
