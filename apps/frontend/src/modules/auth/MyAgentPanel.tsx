/**
 * MyAgentPanel — shown at the top of every page when signed in.
 *
 * Sections:
 *  - Header: avatar, name, agent address (or "Create agent" CTA)
 *  - Fund agent: Circle faucet link + Gateway deposit flow (if agent exists)
 *  - TRID budget ring + spend stats
 *  - Auto-hire: select task → let agent hire best service
 */
import { useState, useCallback } from "react";
import axios from "axios";
import { useAuth } from "./AuthContext";
import AgentKeyModal, { AGENT_KEY_STORE, decryptAgentKey } from "./AgentKeyModal";

const API      = import.meta.env.VITE_API_URL      || "https://backend-production-149a.up.railway.app";
const NODE_API = import.meta.env.VITE_NODE_API_URL || "https://node-backend-production-f7a5.up.railway.app";

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

// ── Gateway deposit modal ──────────────────────────────────────────────────────
function DepositModal({
  onClose,
}: {
  agentAddress: string;
  onClose: () => void;
}) {
  const [step, setStep] = useState<"passphrase" | "amount" | "depositing" | "done" | "error">("passphrase");
  const [passphrase, setPassphrase] = useState("");
  const [amountInput, setAmountInput] = useState("2");
  const [errorMsg, setErrorMsg]       = useState("");
  const [resultMsg, setResultMsg]     = useState("");

  const handlePassphrase = useCallback(async () => {
    if (!passphrase) return;
    // Try to decrypt — if it fails we'll catch when depositing
    const stored = localStorage.getItem(AGENT_KEY_STORE);
    if (!stored) {
      setErrorMsg("No encrypted key found in your browser. Please create your agent first.");
      setStep("error");
      return;
    }
    setStep("amount");
  }, [passphrase]);

  const handleDeposit = useCallback(async () => {
    const amount = parseFloat(amountInput);
    if (isNaN(amount) || amount <= 0) return;

    setStep("depositing");
    const decrypted = await decryptAgentKey(passphrase);
    if (!decrypted) {
      setErrorMsg("Wrong passphrase — key decryption failed.");
      setStep("error");
      return;
    }

    try {
      const r = await axios.post(`${NODE_API}/user/gateway-deposit`, {
        private_key: decrypted.privateKey,
        amount_usdc: amount,
      });
      setResultMsg(`✓ ${r.data.amount_deposited} USDC deposited into Circle Gateway`);
      setStep("done");
    } catch (e: any) {
      const detail = e?.response?.data?.hint || e?.response?.data?.detail || e?.response?.data?.error || e.message;
      setErrorMsg(detail || "Deposit failed");
      setStep("error");
    }
  }, [passphrase, amountInput]);

  return (
    <div
      className="fixed inset-0 z-[300] flex items-center justify-center p-4"
      style={{ background: "rgba(0,0,0,0.8)", backdropFilter: "blur(8px)" }}
    >
      <div
        className="w-full max-w-md rounded-2xl p-6 flex flex-col gap-4"
        style={{ background: "var(--surface)", border: "1px solid rgba(0,180,216,0.3)" }}
      >
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-bold" style={{ color: "var(--text-primary)" }}>
            💧 Deposit USDC to Circle Gateway
          </h2>
          <button onClick={onClose} className="text-xs px-2 py-1 rounded-lg" style={{ background: "rgba(255,255,255,0.07)", color: "var(--text-muted)" }}>✕</button>
        </div>

        {step === "passphrase" && (
          <>
            <p className="text-xs" style={{ color: "var(--text-muted)" }}>
              Enter your agent passphrase to decrypt the key for this deposit. The key is never sent to our servers in plaintext — it's decrypted locally in your browser and used only for this transaction.
            </p>
            <div>
              <label className="text-xs mb-1 block" style={{ color: "var(--text-muted)" }}>Passphrase</label>
              <input
                type="password"
                value={passphrase}
                onChange={e => setPassphrase(e.target.value)}
                placeholder="Your agent passphrase…"
                className="w-full px-3 py-2 rounded-xl text-sm outline-none"
                style={{ background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.12)", color: "var(--text-primary)" }}
                onKeyDown={e => e.key === "Enter" && handlePassphrase()}
              />
            </div>
            <button
              onClick={handlePassphrase}
              disabled={!passphrase}
              className="w-full py-2.5 rounded-xl text-sm font-semibold"
              style={{ background: "var(--accent)", color: "#000" }}
            >
              Continue →
            </button>
          </>
        )}

        {step === "amount" && (
          <>
            <p className="text-xs" style={{ color: "var(--text-muted)" }}>
              How much USDC to deposit into Circle Gateway? Your agent's wallet must already have USDC (from Circle faucet). Each service call costs ~$0.001–$0.020 USDC.
            </p>
            <div>
              <label className="text-xs mb-1 block" style={{ color: "var(--text-muted)" }}>Amount (USDC)</label>
              <input
                type="number"
                min="0.01"
                step="0.5"
                value={amountInput}
                onChange={e => setAmountInput(e.target.value)}
                className="w-full px-3 py-2 rounded-xl text-sm outline-none"
                style={{ background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.12)", color: "var(--text-primary)" }}
              />
            </div>
            <button
              onClick={handleDeposit}
              disabled={!amountInput || parseFloat(amountInput) <= 0}
              className="w-full py-2.5 rounded-xl text-sm font-semibold"
              style={{ background: "var(--accent)", color: "#000" }}
            >
              Deposit {amountInput} USDC →
            </button>
          </>
        )}

        {step === "depositing" && (
          <div className="text-center py-6">
            <div className="text-3xl mb-2">⏳</div>
            <p className="text-sm" style={{ color: "var(--text-muted)" }}>Depositing into Circle Gateway…</p>
          </div>
        )}

        {step === "done" && (
          <div className="text-center py-6">
            <div className="text-3xl mb-2">✅</div>
            <p className="text-sm font-semibold" style={{ color: "#4ade80" }}>{resultMsg}</p>
            <p className="text-xs mt-1" style={{ color: "var(--text-muted)" }}>Your agent can now make x402 payments.</p>
            <button onClick={onClose} className="mt-4 px-4 py-2 rounded-xl text-sm font-semibold" style={{ background: "var(--accent)", color: "#000" }}>Done</button>
          </div>
        )}

        {step === "error" && (
          <div className="text-center py-4">
            <div className="text-3xl mb-2">❌</div>
            <p className="text-xs text-red-400">{errorMsg}</p>
            <button onClick={() => setStep("passphrase")} className="mt-4 px-4 py-2 rounded-xl text-sm" style={{ background: "rgba(255,255,255,0.08)", color: "var(--text-primary)" }}>Try Again</button>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Main panel ────────────────────────────────────────────────────────────────
export default function MyAgentPanel() {
  const { user, refreshUser, setBudget, signOut } = useAuth();
  const [showKeyModal, setShowKeyModal]     = useState(false);
  const [showDepositModal, setShowDepositModal] = useState(false);
  const [showBudget, setShowBudget]         = useState(false);
  const [showFundSection, setShowFundSection] = useState(false);
  const [budgetInput, setBudgetInput]       = useState("");
  const [budgetBusy, setBudgetBusy]         = useState(false);
  const [hireTask, setHireTask]             = useState("price_feed");
  const [hiring, setHiring]                 = useState(false);
  const [hireResult, setHireResult]         = useState<HireResult | null>(null);
  const [hireError, setHireError]           = useState("");

  if (!user) return null;

  // Read agent name from localStorage (set during key creation)
  const storedKey = (() => { try { return JSON.parse(localStorage.getItem(AGENT_KEY_STORE) || "{}"); } catch { return {}; } })();
  const agentDisplayName = storedKey.name || user.name || "My Agent";

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

  // Copy agent address to clipboard
  const [copiedAddr, setCopiedAddr] = useState(false);
  const copyAddress = () => {
    if (!user.agent_address) return;
    navigator.clipboard.writeText(user.agent_address);
    setCopiedAddr(true);
    setTimeout(() => setCopiedAddr(false), 2000);
  };

  return (
    <>
      {showKeyModal    && <AgentKeyModal onClose={() => { setShowKeyModal(false); setShowFundSection(true); }} />}
      {showDepositModal && user.agent_address && (
        <DepositModal agentAddress={user.agent_address} onClose={() => setShowDepositModal(false)} />
      )}

      <div
        className="rounded-2xl p-4 flex flex-col gap-4"
        style={{ background: "rgba(0,180,216,0.05)", border: "1px solid rgba(0,180,216,0.18)" }}
      >
        {/* ── Header ── */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            {user.avatar_url
              ? <img src={user.avatar_url} className="w-7 h-7 rounded-full" alt="" />
              : <div className="w-7 h-7 rounded-full bg-accent/20 flex items-center justify-center text-sm">🤖</div>
            }
            <div>
              <div className="text-xs font-semibold" style={{ color: "var(--text-primary)" }}>
                {agentDisplayName}
              </div>
              {user.agent_address ? (
                <div className="flex items-center gap-1.5">
                  <a
                    href={`https://testnet.arcscan.app/address/${user.agent_address}`}
                    target="_blank"
                    rel="noreferrer"
                    className="text-xs"
                    style={{ color: "var(--accent)", opacity: 0.8 }}
                  >
                    {user.agent_address.slice(0, 8)}…{user.agent_address.slice(-4)} ↗
                  </a>
                  <button
                    onClick={copyAddress}
                    className="text-xs"
                    style={{ color: "var(--text-muted)", opacity: 0.7 }}
                    title="Copy address"
                  >
                    {copiedAddr ? "✓" : "⎘"}
                  </button>
                </div>
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

          <div className="flex items-center gap-2">
            {user.agent_address && (
              <button
                onClick={() => setShowFundSection(f => !f)}
                className="text-xs px-2 py-1 rounded-lg"
                style={{ background: "rgba(0,180,216,0.12)", color: "var(--accent)", border: "1px solid rgba(0,180,216,0.2)" }}
                title="Fund your agent with USDC"
              >
                💧 Fund
              </button>
            )}
            <button
              onClick={signOut}
              className="text-xs px-2 py-1 rounded-lg"
              style={{ background: "rgba(255,255,255,0.07)", color: "var(--text-muted)" }}
            >
              Sign out
            </button>
          </div>
        </div>

        {/* ── Fund Agent Section ── */}
        {showFundSection && user.agent_address && (
          <div
            className="rounded-xl p-3 flex flex-col gap-2.5"
            style={{ background: "rgba(0,180,216,0.06)", border: "1px solid rgba(0,180,216,0.15)" }}
          >
            <div className="text-xs font-semibold" style={{ color: "var(--accent)" }}>
              💧 Fund your agent
            </div>

            {/* Step 1: Get USDC from faucet */}
            <div className="flex flex-col gap-1">
              <div className="text-xs font-medium" style={{ color: "var(--text-primary)" }}>
                Step 1 — Get testnet USDC
              </div>
              <div className="flex items-center gap-2 flex-wrap">
                <p className="text-xs" style={{ color: "var(--text-muted)" }}>
                  Your agent address:
                </p>
                <code
                  className="text-xs px-2 py-0.5 rounded-lg cursor-pointer"
                  style={{ background: "rgba(255,255,255,0.06)", color: "var(--text-primary)", fontFamily: "monospace" }}
                  onClick={copyAddress}
                  title="Click to copy"
                >
                  {user.agent_address.slice(0, 10)}…{user.agent_address.slice(-6)} {copiedAddr ? "✓" : "⎘"}
                </code>
              </div>
              <a
                href="https://faucet.circle.com"
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg w-fit"
                style={{
                  background: "rgba(0,180,216,0.15)",
                  border: "1px solid rgba(0,180,216,0.3)",
                  color: "var(--accent)",
                  textDecoration: "none",
                }}
              >
                Open faucet.circle.com ↗
                <span style={{ color: "var(--text-muted)", fontWeight: 400 }}>— paste your agent address → claim USDC</span>
              </a>
            </div>

            {/* Divider */}
            <div style={{ height: 1, background: "rgba(255,255,255,0.06)" }} />

            {/* Step 2: Deposit to Gateway */}
            <div className="flex flex-col gap-1">
              <div className="text-xs font-medium" style={{ color: "var(--text-primary)" }}>
                Step 2 — Deposit to Circle Gateway
              </div>
              <p className="text-xs" style={{ color: "var(--text-muted)" }}>
                After claiming USDC, deposit it into Circle Gateway so your agent can make x402 payments for marketplace services.
              </p>
              <button
                onClick={() => setShowDepositModal(true)}
                className="text-xs px-3 py-1.5 rounded-lg w-fit font-semibold"
                style={{ background: "var(--accent)", color: "#000" }}
              >
                Deposit to Gateway →
              </button>
            </div>
          </div>
        )}

        {/* ── Budget ring (only when agent exists) ── */}
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

        {/* ── Budget setter ── */}
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

        {/* ── Agent-initiated hire ── */}
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

        {/* ── Hire result ── */}
        {hireResult && (
          <div
            className="rounded-xl p-3 text-xs flex flex-col gap-1"
            style={{ background: "rgba(0,255,120,0.06)", border: "1px solid rgba(0,255,120,0.2)" }}
          >
            <div className="font-semibold" style={{ color: "#4ade80" }}>
              ✓ Hired {hireResult.agent_used.name} (rep: {(hireResult.agent_used.reputation_score / 100).toFixed(1)})
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
