/**
 * MyAgentPanel — shown at the top of every page when signed in.
 *
 * Key feature: "Unlock Agent" flow
 *   - User enters passphrase once per session
 *   - Private key is decrypted locally and held in React state (never persisted)
 *   - All auto-hire calls send the key so payments come from the user's own
 *     Circle Gateway balance, not the shared platform agent
 *   - "Lock" button clears the key from memory immediately
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
    paid_by_agent: string;
    payment_source: "user_agent" | "shared_agent" | "none";
  };
  agent_used: { name: string; address: string; reputation_score: number };
  budget: { remaining_display: string };
}

// ── Gateway deposit modal ─────────────────────────────────────────────────────
function DepositModal({
  onClose,
}: {
  agentAddress: string;
  onClose: () => void;
}) {
  const [step, setStep]       = useState<"passphrase" | "amount" | "depositing" | "done" | "error">("passphrase");
  const [passphrase, setPass] = useState("");
  const [amount, setAmount]   = useState("2");
  const [errorMsg, setErr]    = useState("");
  const [resultMsg, setResult] = useState("");

  const goToAmount = useCallback(async () => {
    const stored = localStorage.getItem(AGENT_KEY_STORE);
    if (!stored) { setErr("No encrypted key found. Create your agent first."); setStep("error"); return; }
    setStep("amount");
  }, []);

  const handleDeposit = useCallback(async () => {
    const n = parseFloat(amount);
    if (isNaN(n) || n <= 0) return;
    setStep("depositing");
    const dec = await decryptAgentKey(passphrase);
    if (!dec) { setErr("Wrong passphrase — key decryption failed."); setStep("error"); return; }
    try {
      const r = await axios.post(`${NODE_API}/user/gateway-deposit`, { private_key: dec.privateKey, amount_usdc: n });
      setResult(`✓ ${r.data.amount_deposited} USDC deposited into Circle Gateway`);
      setStep("done");
    } catch (e: any) {
      const d = e?.response?.data;
      setErr(d?.hint || d?.detail || d?.error || e.message || "Deposit failed");
      setStep("error");
    }
  }, [passphrase, amount]);

  return (
    <div className="fixed inset-0 z-[300] flex items-center justify-center p-4"
      style={{ background: "rgba(0,0,0,0.8)", backdropFilter: "blur(8px)" }}>
      <div className="w-full max-w-md rounded-2xl p-6 flex flex-col gap-4"
        style={{ background: "var(--surface)", border: "1px solid rgba(0,180,216,0.3)" }}>
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-bold" style={{ color: "var(--text-primary)" }}>💧 Deposit to Circle Gateway</h2>
          <button onClick={onClose} className="text-xs px-2 py-1 rounded-lg"
            style={{ background: "rgba(255,255,255,0.07)", color: "var(--text-muted)" }}>✕</button>
        </div>

        {step === "passphrase" && (<>
          <p className="text-xs" style={{ color: "var(--text-muted)" }}>
            Enter your agent passphrase to decrypt the key locally. It's used only for this deposit — never sent to our servers.
          </p>
          <input type="password" value={passphrase} onChange={e => setPass(e.target.value)}
            placeholder="Agent passphrase…" onKeyDown={e => e.key === "Enter" && goToAmount()}
            className="w-full px-3 py-2 rounded-xl text-sm outline-none"
            style={{ background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.12)", color: "var(--text-primary)" }} />
          <button onClick={goToAmount} disabled={!passphrase} className="w-full py-2.5 rounded-xl text-sm font-semibold"
            style={{ background: "var(--accent)", color: "#000" }}>Continue →</button>
        </>)}

        {step === "amount" && (<>
          <p className="text-xs" style={{ color: "var(--text-muted)" }}>
            How much USDC to deposit? Your agent wallet must have USDC first (from faucet.circle.com). Each call costs ~$0.001–$0.020.
          </p>
          <input type="number" min="0.01" step="0.5" value={amount} onChange={e => setAmount(e.target.value)}
            className="w-full px-3 py-2 rounded-xl text-sm outline-none"
            style={{ background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.12)", color: "var(--text-primary)" }} />
          <button onClick={handleDeposit} disabled={!amount || parseFloat(amount) <= 0}
            className="w-full py-2.5 rounded-xl text-sm font-semibold" style={{ background: "var(--accent)", color: "#000" }}>
            Deposit {amount} USDC →
          </button>
        </>)}

        {step === "depositing" && (
          <div className="text-center py-6"><div className="text-3xl mb-2">⏳</div>
            <p className="text-sm" style={{ color: "var(--text-muted)" }}>Depositing into Circle Gateway…</p></div>
        )}

        {step === "done" && (
          <div className="text-center py-6">
            <div className="text-3xl mb-2">✅</div>
            <p className="text-sm font-semibold" style={{ color: "#4ade80" }}>{resultMsg}</p>
            <p className="text-xs mt-1" style={{ color: "var(--text-muted)" }}>Your agent can now make x402 payments.</p>
            <button onClick={onClose} className="mt-4 px-4 py-2 rounded-xl text-sm font-semibold"
              style={{ background: "var(--accent)", color: "#000" }}>Done</button>
          </div>
        )}

        {step === "error" && (
          <div className="text-center py-4">
            <div className="text-3xl mb-2">❌</div>
            <p className="text-xs text-red-400">{errorMsg}</p>
            <button onClick={() => setStep("passphrase")} className="mt-4 px-4 py-2 rounded-xl text-sm"
              style={{ background: "rgba(255,255,255,0.08)", color: "var(--text-primary)" }}>Try Again</button>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Inline passphrase unlock (shown above auto-hire when agent is locked) ─────
function UnlockRow({ onUnlock }: { onUnlock: (key: string) => void }) {
  const [pass, setPass]   = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy]   = useState(false);

  const tryUnlock = useCallback(async () => {
    setBusy(true);
    setError("");
    const dec = await decryptAgentKey(pass);
    if (!dec) {
      setError("Wrong passphrase");
      setBusy(false);
      return;
    }
    onUnlock(dec.privateKey);
  }, [pass, onUnlock]);

  return (
    <div className="flex flex-col gap-1.5">
      <div className="text-xs" style={{ color: "var(--text-muted)" }}>
        🔒 Unlock your agent to pay from your own Circle Gateway balance
      </div>
      <div className="flex gap-2">
        <input
          type="password"
          value={pass}
          onChange={e => { setPass(e.target.value); setError(""); }}
          placeholder="Agent passphrase…"
          onKeyDown={e => e.key === "Enter" && pass && tryUnlock()}
          className="flex-1 px-3 py-2 rounded-xl text-xs outline-none"
          style={{ background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.12)", color: "var(--text-primary)" }}
        />
        <button
          onClick={tryUnlock}
          disabled={busy || !pass}
          className="px-3 py-2 rounded-xl text-xs font-semibold shrink-0"
          style={{ background: "var(--accent)", color: "#000", opacity: (!pass || busy) ? 0.5 : 1 }}
        >
          {busy ? "…" : "Unlock"}
        </button>
      </div>
      {error && <p className="text-xs text-red-400">{error}</p>}
    </div>
  );
}

// ── Main panel ────────────────────────────────────────────────────────────────
export default function MyAgentPanel() {
  const { user, refreshUser, setBudget, signOut } = useAuth();

  // Session-only in-memory key — never written to localStorage or sent to Python logs
  const [unlockedKey, setUnlockedKey] = useState<string | null>(null);

  const [showKeyModal, setShowKeyModal]       = useState(false);
  const [showDepositModal, setShowDepositModal] = useState(false);
  const [showFundSection, setShowFundSection] = useState(false);
  const [showBudget, setShowBudget]           = useState(false);
  const [budgetInput, setBudgetInput]         = useState("");
  const [budgetBusy, setBudgetBusy]           = useState(false);
  const [hireTask, setHireTask]               = useState("price_feed");
  const [hiring, setHiring]                   = useState(false);
  const [hireResult, setHireResult]           = useState<HireResult | null>(null);
  const [hireError, setHireError]             = useState("");
  const [copiedAddr, setCopiedAddr]           = useState(false);

  if (!user) return null;

  const storedMeta = (() => {
    try { return JSON.parse(localStorage.getItem(AGENT_KEY_STORE) || "{}"); } catch { return {}; }
  })();
  const agentDisplayName = storedMeta.name || user.name || "My Agent";

  const budgetTrid = (user.max_trid_budget || 0) / 1_000_000;
  const spentTrid  = (user.trid_spent || 0) / 1_000_000;
  const remainTrid = Math.max(0, budgetTrid - spentTrid);
  const pctUsed    = budgetTrid > 0 ? Math.min(100, (spentTrid / budgetTrid) * 100) : 0;

  const handleBudgetSave = async () => {
    const val = parseFloat(budgetInput);
    if (isNaN(val) || val < 0) return;
    setBudgetBusy(true);
    try { await setBudget(Math.round(val * 1_000_000)); setShowBudget(false); setBudgetInput(""); }
    finally { setBudgetBusy(false); }
  };

  const handleAgentHire = async () => {
    setHiring(true);
    setHireError("");
    setHireResult(null);
    try {
      const body: Record<string, unknown> = { service_type: hireTask, params: {}, auto_select: true };
      // If agent is unlocked, include private key so payment comes from user's own Gateway
      if (unlockedKey) body.agent_private_key = unlockedKey;

      const r = await axios.post(`${API}/api/user-agent/hire`, body);
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

  const copyAddress = () => {
    if (!user.agent_address) return;
    navigator.clipboard.writeText(user.agent_address);
    setCopiedAddr(true);
    setTimeout(() => setCopiedAddr(false), 2000);
  };

  const agentLocked = user.agent_address && !unlockedKey;

  return (
    <>
      {showKeyModal && (
        <AgentKeyModal onClose={() => { setShowKeyModal(false); setShowFundSection(true); }} />
      )}
      {showDepositModal && user.agent_address && (
        <DepositModal agentAddress={user.agent_address} onClose={() => setShowDepositModal(false)} />
      )}

      <div className="rounded-2xl p-4 flex flex-col gap-4"
        style={{ background: "rgba(0,180,216,0.05)", border: "1px solid rgba(0,180,216,0.18)" }}>

        {/* ── Header ── */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            {user.avatar_url
              ? <img src={user.avatar_url} className="w-7 h-7 rounded-full" alt="" />
              : <div className="w-7 h-7 rounded-full flex items-center justify-center text-sm"
                  style={{ background: "rgba(0,180,216,0.2)" }}>🤖</div>
            }
            <div>
              <div className="text-xs font-semibold" style={{ color: "var(--text-primary)" }}>
                {agentDisplayName}
                {/* Lock indicator */}
                {user.agent_address && (
                  <span className="ml-1.5 text-xs" title={unlockedKey ? "Agent unlocked — paying from your Gateway" : "Agent locked"}>
                    {unlockedKey ? "🔓" : "🔒"}
                  </span>
                )}
              </div>
              {user.agent_address ? (
                <div className="flex items-center gap-1.5">
                  <a href={`https://testnet.arcscan.app/address/${user.agent_address}`}
                    target="_blank" rel="noreferrer" className="text-xs"
                    style={{ color: "var(--accent)", opacity: 0.8 }}>
                    {user.agent_address.slice(0, 8)}…{user.agent_address.slice(-4)} ↗
                  </a>
                  <button onClick={copyAddress} className="text-xs" title="Copy address"
                    style={{ color: "var(--text-muted)", opacity: 0.7 }}>
                    {copiedAddr ? "✓" : "⎘"}
                  </button>
                </div>
              ) : (
                <button onClick={() => setShowKeyModal(true)} className="text-xs"
                  style={{ color: "var(--accent)" }}>Create agent →</button>
              )}
            </div>
          </div>

          <div className="flex items-center gap-2">
            {user.agent_address && (
              <button onClick={() => setShowFundSection(f => !f)}
                className="text-xs px-2 py-1 rounded-lg"
                style={{ background: "rgba(0,180,216,0.12)", color: "var(--accent)", border: "1px solid rgba(0,180,216,0.2)" }}
                title="Fund your agent">
                💧 Fund
              </button>
            )}
            {unlockedKey && (
              <button onClick={() => setUnlockedKey(null)}
                className="text-xs px-2 py-1 rounded-lg"
                style={{ background: "rgba(255,60,60,0.1)", color: "#ff8080", border: "1px solid rgba(255,60,60,0.2)" }}
                title="Clear key from session memory">
                🔒 Lock
              </button>
            )}
            <button onClick={signOut} className="text-xs px-2 py-1 rounded-lg"
              style={{ background: "rgba(255,255,255,0.07)", color: "var(--text-muted)" }}>
              Sign out
            </button>
          </div>
        </div>

        {/* ── Fund section ── */}
        {showFundSection && user.agent_address && (
          <div className="rounded-xl p-3 flex flex-col gap-2.5"
            style={{ background: "rgba(0,180,216,0.06)", border: "1px solid rgba(0,180,216,0.15)" }}>
            <div className="text-xs font-semibold" style={{ color: "var(--accent)" }}>💧 Fund your agent</div>

            <div>
              <div className="text-xs font-medium mb-1" style={{ color: "var(--text-primary)" }}>Step 1 — Get testnet USDC</div>
              <div className="flex items-center gap-2 mb-1 flex-wrap">
                <span className="text-xs" style={{ color: "var(--text-muted)" }}>Agent address:</span>
                <code className="text-xs px-2 py-0.5 rounded-lg cursor-pointer" onClick={copyAddress} title="Click to copy"
                  style={{ background: "rgba(255,255,255,0.06)", color: "var(--text-primary)", fontFamily: "monospace" }}>
                  {user.agent_address.slice(0, 10)}…{user.agent_address.slice(-6)} {copiedAddr ? "✓" : "⎘"}
                </code>
              </div>
              <a href="https://faucet.circle.com" target="_blank" rel="noreferrer"
                className="inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg w-fit"
                style={{ background: "rgba(0,180,216,0.15)", border: "1px solid rgba(0,180,216,0.3)", color: "var(--accent)", textDecoration: "none" }}>
                Open faucet.circle.com ↗
                <span style={{ color: "var(--text-muted)", fontWeight: 400 }}>— paste your agent address</span>
              </a>
            </div>

            <div style={{ height: 1, background: "rgba(255,255,255,0.06)" }} />

            <div>
              <div className="text-xs font-medium mb-1" style={{ color: "var(--text-primary)" }}>Step 2 — Deposit to Circle Gateway</div>
              <p className="text-xs mb-1.5" style={{ color: "var(--text-muted)" }}>
                Moves USDC from your agent's wallet into Circle Gateway so it can make x402 payments.
              </p>
              <button onClick={() => setShowDepositModal(true)}
                className="text-xs px-3 py-1.5 rounded-lg w-fit font-semibold"
                style={{ background: "var(--accent)", color: "#000" }}>
                Deposit to Gateway →
              </button>
            </div>
          </div>
        )}

        {/* ── Budget ring ── */}
        {user.agent_address && (
          <div className="flex items-center gap-4">
            <div className="relative w-14 h-14 shrink-0">
              <svg viewBox="0 0 48 48" className="w-full h-full -rotate-90">
                <circle cx="24" cy="24" r="20" fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth="4" />
                <circle cx="24" cy="24" r="20" fill="none" stroke="var(--accent)" strokeWidth="4"
                  strokeLinecap="round" strokeDasharray={`${pctUsed * 1.257} 125.7`} />
              </svg>
              <div className="absolute inset-0 flex items-center justify-center text-xs font-bold"
                style={{ color: "var(--accent)" }}>{Math.round(pctUsed)}%</div>
            </div>
            <div className="flex-1">
              <div className="text-xs" style={{ color: "var(--text-muted)" }}>TRID Budget</div>
              <div className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>
                {remainTrid.toFixed(4)} <span style={{ color: "var(--text-muted)", fontWeight: 400 }}>/ {budgetTrid.toFixed(4)}</span>
              </div>
              <div className="text-xs" style={{ color: "var(--text-muted)" }}>{spentTrid.toFixed(4)} TRID spent</div>
            </div>
            <button onClick={() => setShowBudget(b => !b)}
              className="text-xs px-2 py-1 rounded-lg shrink-0"
              style={{ background: "rgba(0,180,216,0.12)", color: "var(--accent)" }}>
              Set budget
            </button>
          </div>
        )}

        {/* ── Budget input ── */}
        {showBudget && (
          <div className="flex gap-2">
            <input type="number" min="0" step="1" value={budgetInput} onChange={e => setBudgetInput(e.target.value)}
              placeholder="e.g. 10 TRID" className="flex-1 px-3 py-2 rounded-xl text-sm outline-none"
              style={{ background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.12)", color: "var(--text-primary)" }} />
            <button onClick={handleBudgetSave} disabled={budgetBusy} className="px-3 py-2 rounded-xl text-sm font-semibold"
              style={{ background: "var(--accent)", color: "#000" }}>
              {budgetBusy ? "…" : "Save"}
            </button>
          </div>
        )}

        {/* ── Auto-hire section ── */}
        {user.agent_address && (
          <div className="flex flex-col gap-2">
            {/* Unlock prompt (shown when agent is locked and budget is set) */}
            {agentLocked && user.max_trid_budget ? (
              <UnlockRow onUnlock={setUnlockedKey} />
            ) : user.agent_address && (
              <>
                {unlockedKey && (
                  <div className="text-xs flex items-center gap-1" style={{ color: "#4ade80" }}>
                    🔓 <span>Agent unlocked — payments from your Circle Gateway balance</span>
                  </div>
                )}
                <div className="text-xs" style={{ color: "var(--text-muted)" }}>Let your agent hire the best service</div>
                <div className="flex gap-2">
                  <select value={hireTask} onChange={e => setHireTask(e.target.value)}
                    className="flex-1 px-3 py-2 rounded-xl text-xs outline-none"
                    style={{ background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.12)", color: "var(--text-primary)" }}>
                    <option value="price_feed">Price Feed</option>
                    <option value="fx_rates">FX Rates</option>
                    <option value="risk_score">Risk Score</option>
                    <option value="compute_score">Portfolio Score</option>
                    <option value="retrobot_audit">Retrobot Audit</option>
                  </select>
                  <button onClick={handleAgentHire} disabled={hiring || !user.max_trid_budget}
                    className="px-3 py-2 rounded-xl text-xs font-semibold shrink-0"
                    style={{ background: "var(--accent)", color: "#000", opacity: (hiring || !user.max_trid_budget) ? 0.5 : 1 }}>
                    {hiring ? "⏳" : "Auto-hire"}
                  </button>
                </div>
              </>
            )}
            {!user.max_trid_budget && (
              <p className="text-xs" style={{ color: "var(--text-muted)" }}>Set a budget above to enable auto-hire</p>
            )}
          </div>
        )}

        {/* ── Hire result ── */}
        {hireResult && (
          <div className="rounded-xl p-3 text-xs flex flex-col gap-1"
            style={{ background: "rgba(0,255,120,0.06)", border: "1px solid rgba(0,255,120,0.2)" }}>
            <div className="font-semibold" style={{ color: "#4ade80" }}>
              ✓ Hired {hireResult.agent_used.name} (rep: {(hireResult.agent_used.reputation_score / 100).toFixed(1)})
            </div>
            <div style={{ color: "var(--text-muted)" }}>
              Paid {hireResult.payment.trid_display}
              {hireResult.payment.usdc_gateway && ` + ${hireResult.payment.usdc_gateway} USDC via Gateway`}
            </div>
            {hireResult.payment.payment_source === "user_agent" && (
              <div style={{ color: "#4ade80", opacity: 0.8 }}>
                💳 Paid from your own Gateway balance ({hireResult.payment.paid_by_agent.slice(0, 8)}…)
              </div>
            )}
            <div style={{ color: "var(--text-muted)" }}>
              Budget remaining: {hireResult.budget.remaining_display}
            </div>
          </div>
        )}

        {hireError && <p className="text-xs text-red-400">{hireError}</p>}
      </div>
    </>
  );
}
