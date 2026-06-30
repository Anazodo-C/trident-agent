import { useState } from "react";
import { useAccount } from "wagmi";
import axios from "axios";
import { useToast } from "./Toast";

const API = import.meta.env.VITE_API_URL || "http://localhost:8000";

const SERVICE_TYPES = [
  { value: "price_feed",       label: "Price Feed" },
  { value: "fx_rates",         label: "FX Rates" },
  { value: "risk_score",       label: "Risk Score" },
  { value: "research_summary", label: "AI Research" },
  { value: "compute_score",    label: "Portfolio Score" },
  { value: "retrobot_audit",   label: "Retrobot Audit" },
  { value: "custom",           label: "Custom" },
];

interface Props {
  onClose:   () => void;
  onSuccess: () => void;
}

export default function UploadAgentModal({ onClose, onSuccess }: Props) {
  const { address, isConnected } = useAccount();
  const { show, dismiss } = useToast();

  const [form, setForm] = useState({
    name:         "",
    agent_type:   "price_feed",
    description:  "",
    endpoint:     "",
    price:        "0.001",
  });
  const [step, setStep] = useState<"form" | "registering" | "done">("form");
  const [arcResult, setArcResult] = useState<Record<string, unknown> | null>(null);

  const set = (k: keyof typeof form, v: string) => setForm(f => ({ ...f, [k]: v }));

  const handleSubmit = async () => {
    if (!isConnected || !address) {
      show("Connect your wallet first", "error");
      return;
    }
    if (!form.name.trim()) { show("Enter an agent name", "error"); return; }

    setStep("registering");
    const tid = show("Registering your agent on-chain…", "loading");

    try {
      const res = await axios.post(`${API}/api/agents/register`, {
        name:         form.name.trim(),
        agent_type:   form.agent_type,
        description:  form.description.trim(),
        wallet:       address,
        endpoint:     form.endpoint.trim() || `/api/custom/${form.name.toLowerCase().replace(/\s+/g, "-")}`,
        price_per_call: Math.round(parseFloat(form.price) * 1_000_000),
        price_trid_display: `${form.price} TRID`,
      });

      dismiss(tid);
      setArcResult(res.data?.arc_identity || null);
      setStep("done");
      show(`"${form.name}" registered!`, "success", 4000);
    } catch (e: any) {
      dismiss(tid);
      const msg = e?.response?.data?.detail || "Registration failed";
      show(msg, "error", 4000);
      setStep("form");
    }
  };

  return (
    <div className="modal-overlay">
      <div className="modal-box" style={{ maxWidth: 480 }}>
        {/* Header */}
        <div className="flex items-center justify-between p-6 pb-0">
          <div>
            <h2 className="font-bold text-lg" style={{ color: "var(--text-primary)" }}>
              🚀 Offer a Service
            </h2>
            <p className="text-xs mt-0.5" style={{ color: "var(--text-muted)" }}>
              Register your agent on Arc Testnet
            </p>
          </div>
          <button onClick={onClose} className="btn-ghost text-lg leading-none">✕</button>
        </div>

        {step === "done" ? (
          <div className="p-6 text-center">
            <div className="text-5xl mb-4">🎉</div>
            <h3 className="font-bold text-base mb-2" style={{ color: "var(--text-primary)" }}>
              Agent Registered!
            </h3>
            {arcResult && Boolean(arcResult.registered) && (
              <div
                className="rounded-xl p-4 mb-4 text-left mono text-xs"
                style={{ background: "rgba(0,180,216,0.07)", border: "1px solid rgba(0,180,216,0.2)" }}
              >
                <div style={{ color: "var(--text-muted)" }}>Arc Agent ID</div>
                <div className="font-bold mt-0.5" style={{ color: "var(--accent)" }}>
                  #{arcResult.arc_agent_id != null ? String(arcResult.arc_agent_id) : "—"}
                </div>
                {arcResult.arc_scan ? (
                  <a
                    href={String(arcResult.arc_scan)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs mt-2 block underline"
                    style={{ color: "var(--text-muted)" }}
                  >
                    View on ArcScan ↗
                  </a>
                ) : null}
              </div>
            )}
            <button
              onClick={() => { onSuccess(); onClose(); }}
              className="btn-primary w-full"
            >
              View in Agents
            </button>
          </div>
        ) : (
          <div className="p-6 space-y-4">
            {/* Name */}
            <div>
              <label className="text-xs font-semibold mb-1.5 block" style={{ color: "var(--text-muted)" }}>
                Agent Name *
              </label>
              <input
                className="input"
                placeholder="e.g. Alpha Price Oracle"
                value={form.name}
                onChange={e => set("name", e.target.value)}
              />
            </div>

            {/* Type */}
            <div>
              <label className="text-xs font-semibold mb-1.5 block" style={{ color: "var(--text-muted)" }}>
                Service Type *
              </label>
              <select
                className="input"
                value={form.agent_type}
                onChange={e => set("agent_type", e.target.value)}
              >
                {SERVICE_TYPES.map(t => (
                  <option key={t.value} value={t.value}>{t.label}</option>
                ))}
              </select>
            </div>

            {/* Description */}
            <div>
              <label className="text-xs font-semibold mb-1.5 block" style={{ color: "var(--text-muted)" }}>
                Description
              </label>
              <textarea
                className="input resize-none"
                rows={2}
                placeholder="What does your agent do?"
                value={form.description}
                onChange={e => set("description", e.target.value)}
              />
            </div>

            {/* Price */}
            <div>
              <label className="text-xs font-semibold mb-1.5 block" style={{ color: "var(--text-muted)" }}>
                Price per Call (TRID)
              </label>
              <input
                className="input"
                type="number"
                step="0.001"
                min="0.001"
                value={form.price}
                onChange={e => set("price", e.target.value)}
              />
            </div>

            {/* Endpoint (optional) */}
            <div>
              <label className="text-xs font-semibold mb-1.5 block" style={{ color: "var(--text-muted)" }}>
                Endpoint URL <span className="opacity-50">(optional)</span>
              </label>
              <input
                className="input"
                placeholder="https://your-agent.xyz/api"
                value={form.endpoint}
                onChange={e => set("endpoint", e.target.value)}
              />
            </div>

            {/* Wallet info */}
            <div
              className="rounded-xl p-3 mono text-xs"
              style={{ background: "rgba(0,180,216,0.06)", border: "1px solid rgba(0,180,216,0.15)" }}
            >
              <span style={{ color: "var(--text-muted)" }}>Owner: </span>
              <span style={{ color: "var(--accent)" }}>{address?.slice(0, 8)}…{address?.slice(-6)}</span>
            </div>

            <div className="flex gap-3 pt-2">
              <button
                onClick={handleSubmit}
                disabled={step === "registering"}
                className="btn-primary flex-1"
              >
                {step === "registering" ? "Registering…" : "Register Agent"}
              </button>
              <button onClick={onClose} className="btn-secondary">Cancel</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
