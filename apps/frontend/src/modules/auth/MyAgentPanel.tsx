/**
 * MyAgentPanel — shown in the sidebar/header of AgentsPage when user is signed in.
 * Shows: agent address, TRID budget ring, spent/remaining, budget setter, hire via agent.
 */
import { useState } from "react";
import axios from "axios";
import { useAuth } from "./AuthContext";
import AgentKeyModal from "./AgentKeyModal";

const API = import.meta.env.VITE_API_URL || "https://backend-production-149a.up.railway.app";

interface HireResult {
  data: unknown;
  payment: {
    trid_display: string;
    usdc_gateway: string | null;
    trid_to_usdc_rate: string;
    transaction_ref: string | null;
  };
  agent_used: { name: string; address: string; reputation_score: number };
  budget: { remaining_display: string };
}

export default function MyAgentPanel() {
  const { user, refreshUser, setBudget, signOut } = useAuth();
  const [showKeyModal, setShowKeyModal] = useState(false);
  const [showBudget, setShowBudget]     = useState(false);
  const [budgetInput, setBudgetInput]   = useState("");
  const [budgetBusy, setBudgetBusy]     = useState(false);
  const [hireTask, setHireTask]         = useState("price_feed");
  const [hiring, setHiring]             = useState(false);
  const [hireResult, setHireResult]     = useState<HireResult | null>(null);
  const [hireError, setHireError]       = useState("");

  if (!user) return null;

  const budgetTrid = (user.max_trid_budget || 0) / 1_000_000;
  const spentTrid  = (user.trid_spent || 0) / 1_000_000;
  const remainTrid = Math.max(0, budgetTrid - spentTrid);
  const pctUsed    = budgetTrid > 0 ? Math.min(100, (spentTrid / budgetTrid) * 100) : 0;

  const handleBudgetSave = async () => {
    const val = parseFloat(budgetInput);
    if (isNaN(val) || val < 0) return;
    setBudgetBusy(true);
    try {
      await setBudget(Math.round(val * 1_000_000));
      setShowBudget(false);
      setBudgetInput("");
    } finally {
      setBudgetBusy(false);
    }
  };

  const handleAgentHire = async () => {
    setHiring(true);
    setHireError("");
    setHireResult(null);
    try {
      const r = await axios.post(`${API}/api/user-agent/hire`, {
        service_type: hireTask,
        params: {},
        auto_select: true,
      });
      setHireResult(r.data);
      await refreshUser();
    } catch (e: any) {
      const detail = e?.response?.data?.detail;
      setHireError(
        typeof detail === "object"
          ? detail.message || JSON.stringify(detail)
          : detail || e.message || "Hire failed"
      );
    } finally {
      setHiring(false);
    }
  };

  return (
    <>
      {showKeyModal && <AgentKeyModal onClose={() => setShowKeyModal(false)} />}

      <div
        className="rounded-2xl p-4 flex flex-col gap-4"
        style={{
          background: "rgba(0,180,216,0.05)",
          border: "1px solid rgba(0,180,216,0.18)",
        }}
      >
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            {user.avatar_url
              ? <img src={user.avatar_url} className="w-7 h-7 rounded-full" alt="" />
              : <div className="w-7 h-7 rounded-full bg-accent/20 flex items-center justify-center text-xs">🤖</div>
            }
            <div>
              <div className="text-xs font-semibold" style={{ color: "var(--text-primary)" }}>
                {user.name || user.email || "My Agent"}
              </div>
              {user.agent_address ? (
                <a
                  href={`https://testnet.arcscan.app/address/${user.agent_address}`}
                  target="_blank"
                  rel="noreferrer"
                  className="text-xs"
                  style={{ color: "var(--accent)", opacity: 0.8 }}
                >
                  {user.agent_address.slice(0, 8)}…{user.agent_address.slice(-4)} ↗
                </a>
              ) : (
                <button
                  onClick={() => setShowKeyModal(true)}
                  className="text-xs"
                  style={{ color: "var(--accent)" }}
                >
                  Create agent →
                </button>
              )}
            </div>
          </div>
          <button
            onClick={signOut}
            className="text-xs px-2 py-1 rounded-lg"
            style={{ background: "rgba(255,255,255,0.07)", color: "var(--text-muted)" }}
          >
            Sign out
          </button>
        </div>

        {/* Budget ring */}
        {user.agent_address && (
          <div className="flex items-center gap-4">
            {/* Progress ring */}
            <div className="relative w-14 h-14 shrink-0">
              <svg viewBox="0 0 48 48" className="w-full h-full -rotate-90">
                <circle cx="24" cy="24" r="20" fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth="4" />
                <circle
                  cx="24" cy="24" r="20" fill="none"
                  stroke="var(--accent)" strokeWidth="4"
                  strokeLinecap="round"
                  strokeDasharray={`${pctUsed * 1.257} 125.7`}
                />
              </svg>
              <div
                className="absolute inset-0 flex items-center justify-center text-xs font-bold"
                style={{ color: "var(--accent)" }}
              >
                {Math.round(pctUsed)}%
              </div>
            </div>

            {/* Budget numbers */}
            <div className="flex-1">
              <div className="text-xs" style={{ color: "var(--text-muted)" }}>TRID Budget</div>
              <div className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>
                {remainTrid.toFixed(4)} <span style={{ color: "var(--text-muted)", fontWeight: 400 }}>/ {budgetTrid.toFixed(4)}</span>
              </div>
              <div className="text-xs" style={{ color: "var(--text-muted)" }}>
                {spentTrid.toFixed(4)} TRID spent
              </div>
            </div>

            <button
              onClick={() => setShowBudget(b => !b)}
              className="text-xs px-2 py-1 rounded-lg shrink-0"
              style={{ background: "rgba(0,180,216,0.12)", color: "var(--accent)" }}
            >
              Set budget
            </button>
          </div>
        )}

        {/* Budget setter */}
        {showBudget && (
          <div className="flex gap-2">
            <input
              type="number"
              min="0"
              step="1"
              value={budgetInput}
              onChange={e => setBudgetInput(e.target.value)}
              placeholder="e.g. 10 TRID"
              className="flex-1 px-3 py-2 rounded-xl text-sm outline-none"
              style={{ background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.12)", color: "var(--text-primary)" }}
            />
            <button
              onClick={handleBudgetSave}
              disabled={budgetBusy}
              className="px-3 py-2 rounded-xl text-sm font-semibold"
              style={{ background: "var(--accent)", color: "#000" }}
            >
              {budgetBusy ? "…" : "Save"}
            </button>
          </div>
        )}

        {/* Agent-initiated hire */}
        {user.agent_address && (
          <div className="flex flex-col gap-2">
            <div className="text-xs" style={{ color: "var(--text-muted)" }}>Let your agent hire the best service</div>
            <div className="flex gap-2">
              <select
                value={hireTask}
                onChange={e => setHireTask(e.target.value)}
                className="flex-1 px-3 py-2 rounded-xl text-xs outline-none"
                style={{ background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.12)", color: "var(--text-primary)" }}
              >
                <option value="price_feed">Price Feed</option>
                <option value="fx_rates">FX Rates</option>
                <option value="risk_score">Risk Score</option>
                <option value="compute_score">Portfolio Score</option>
                <option value="retrobot_audit">Retrobot Audit</option>
              </select>
              <button
                onClick={handleAgentHire}
                disabled={hiring || !user.max_trid_budget}
                className="px-3 py-2 rounded-xl text-xs font-semibold shrink-0"
                style={{ background: "var(--accent)", color: "#000", opacity: (hiring || !user.max_trid_budget) ? 0.5 : 1 }}
              >
                {hiring ? "⏳" : "Auto-hire"}
              </button>
            </div>
            {!user.max_trid_budget && (
              <p className="text-xs" style={{ color: "var(--text-muted)" }}>Set a budget above to enable auto-hire</p>
            )}
          </div>
        )}

        {/* Hire result */}
        {hireResult && (
          <div
            className="rounded-xl p-3 text-xs flex flex-col gap-1"
            style={{ background: "rgba(0,255,120,0.06)", border: "1px solid rgba(0,255,120,0.2)" }}
          >
            <div className="font-semibold" style={{ color: "#4ade80" }}>
              ✓ Hired {hireResult.agent_used.name} (rep: {hireResult.agent_used.reputation_score / 100})
            </div>
            <div style={{ color: "var(--text-muted)" }}>
              Paid {hireResult.payment.trid_display}
              {hireResult.payment.usdc_gateway && ` + ${hireResult.payment.usdc_gateway} USDC via Gateway`}
            </div>
            <div style={{ color: "var(--text-muted)" }}>
              Budget remaining: {hireResult.budget.remaining_display}
            </div>
          </div>
        )}

        {hireError && (
          <p className="text-xs text-red-400">{hireError}</p>
        )}
      </div>
    </>
  );
}
