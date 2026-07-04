/**
 * ProfilePage — /profile
 *
 * The user's personal dashboard. All agent/wallet details live here, not
 * on the homepage. Sections:
 *  - Identity card (avatar, name, email, wallet address)
 *  - Agent card (agent name, address, lock/unlock, ArcScan)
 *  - Fund agent (faucet link + Gateway deposit)
 *  - TRID budget (ring + setter)
 *  - Auto-hire (quick service call from this page)
 */
import { useState, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import axios from "axios";
import { useAccount } from "wagmi";

import { useAuth } from "../auth/AuthContext";
import AgentKeyModal, { AGENT_KEY_STORE, decryptAgentKey } from "../auth/AgentKeyModal";

const API      = import.meta.env.VITE_API_URL      || "https://backend-production-149a.up.railway.app";
const NODE_API = import.meta.env.VITE_NODE_API_URL || "https://node-backend-production-f7a5.up.railway.app";

// ── Gateway Deposit Modal ────────────────────────────────────────────────────
function DepositModal({ onClose }: { onClose: () => void }) {
  const [step, setStep]    = useState<"pass" | "amount" | "working" | "ok" | "err">("pass");
  const [pass, setPass]    = useState("");
  const [amount, setAmt]   = useState("2");
  const [msg, setMsg]      = useState("");

  const next = useCallback(async () => {
    if (!localStorage.getItem(AGENT_KEY_STORE)) {
      setMsg("No agent key found — create your agent first."); setStep("err"); return;
    }
    setStep("amount");
  }, []);

  const deposit = useCallback(async () => {
    const n = parseFloat(amount);
    if (isNaN(n) || n <= 0) return;
    setStep("working");
    const dec = await decryptAgentKey(pass);
    if (!dec) { setMsg("Wrong passphrase."); setStep("err"); return; }
    try {
      const r = await axios.post(`${NODE_API}/user/gateway-deposit`, { private_key: dec.privateKey, amount_usdc: n });
      setMsg(`✓ ${r.data.amount_deposited} USDC deposited${r.data.gateway_usdc ? ` · Gateway balance: ${r.data.gateway_usdc} USDC` : ""}`);
      setStep("ok");
    } catch (e: any) {
      const d = e?.response?.data;
      setMsg(d?.hint || d?.detail || d?.error || e.message || "Deposit failed");
      setStep("err");
    }
  }, [pass, amount]);

  return (
    <div className="fixed inset-0 z-[300] flex items-center justify-center p-4"
      style={{ background: "rgba(0,0,0,0.8)", backdropFilter: "blur(8px)" }}>
      <div className="w-full max-w-md rounded-2xl p-6 flex flex-col gap-4"
        style={{ background: "var(--surface)", border: "1px solid rgba(0,180,216,0.3)" }}>
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-bold" style={{ color: "var(--text-primary)" }}>Deposit USDC to Gateway</h2>
          <button onClick={onClose} className="text-xs px-2 py-1 rounded-lg"
            style={{ background: "rgba(255,255,255,0.07)", color: "var(--text-muted)" }}>✕</button>
        </div>

        {step === "pass" && (<>
          <p className="text-xs" style={{ color: "var(--text-muted)" }}>Enter your agent passphrase. Key decrypted locally — never sent to our servers.</p>
          <input type="password" value={pass} onChange={e => setPass(e.target.value)}
            placeholder="Agent passphrase…" onKeyDown={e => e.key === "Enter" && pass && next()}
            className="w-full px-3 py-2 rounded-xl text-sm outline-none"
            style={{ background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.12)", color: "var(--text-primary)" }} />
          <button onClick={next} disabled={!pass} className="w-full py-2.5 rounded-xl text-sm font-semibold"
            style={{ background: "var(--accent)", color: "#000", opacity: pass ? 1 : 0.5 }}>Continue →</button>
        </>)}

        {step === "amount" && (<>
          <p className="text-xs" style={{ color: "var(--text-muted)" }}>Amount of USDC to move from your agent wallet into Circle Gateway. Each service costs ~$0.001–$0.020.</p>
          <input type="number" min="0.1" step="0.5" value={amount} onChange={e => setAmt(e.target.value)}
            className="w-full px-3 py-2 rounded-xl text-sm outline-none"
            style={{ background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.12)", color: "var(--text-primary)" }} />
          <button onClick={deposit} className="w-full py-2.5 rounded-xl text-sm font-semibold"
            style={{ background: "var(--accent)", color: "#000" }}>Deposit {amount} USDC →</button>
        </>)}

        {step === "working" && (
          <div className="text-center py-6"><div className="text-3xl mb-2">⏳</div>
            <p className="text-sm" style={{ color: "var(--text-muted)" }}>Depositing…</p></div>
        )}
        {step === "ok" && (
          <div className="text-center py-6">
            <div className="text-3xl mb-2">✅</div>
            <p className="text-sm font-semibold" style={{ color: "#4ade80" }}>{msg}</p>
            <button onClick={onClose} className="mt-4 px-4 py-2 rounded-xl text-sm font-semibold"
              style={{ background: "var(--accent)", color: "#000" }}>Done</button>
          </div>
        )}
        {step === "err" && (
          <div className="text-center py-4">
            <div className="text-3xl mb-2">❌</div>
            <p className="text-xs text-red-400 mb-3">{msg}</p>
            <button onClick={() => setStep("pass")} className="px-4 py-2 rounded-xl text-sm"
              style={{ background: "rgba(255,255,255,0.08)", color: "var(--text-primary)" }}>Try Again</button>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Unlock row ────────────────────────────────────────────────────────────────
function UnlockRow({ onUnlock }: { onUnlock: (k: string) => void }) {
  const [pass, setPass]   = useState("");
  const [err, setErr]     = useState("");
  const [busy, setBusy]   = useState(false);

  const tryUnlock = useCallback(async () => {
    setBusy(true); setErr("");
    const dec = await decryptAgentKey(pass);
    if (!dec) { setErr("Wrong passphrase"); setBusy(false); return; }
    onUnlock(dec.privateKey);
    setBusy(false);
  }, [pass, onUnlock]);

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex gap-2">
        <input type="password" value={pass} onChange={e => { setPass(e.target.value); setErr(""); }}
          placeholder="Agent passphrase to unlock…"
          onKeyDown={e => e.key === "Enter" && pass && tryUnlock()}
          className="flex-1 px-3 py-2 rounded-xl text-xs outline-none"
          style={{ background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.12)", color: "var(--text-primary)" }} />
        <button onClick={tryUnlock} disabled={busy || !pass}
          className="px-3 py-2 rounded-xl text-xs font-semibold shrink-0"
          style={{ background: "var(--accent)", color: "#000", opacity: (!pass || busy) ? 0.5 : 1 }}>
          {busy ? "…" : "Unlock"}
        </button>
      </div>
      {err && <p className="text-xs text-red-400">{err}</p>}
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────
export default function ProfilePage() {
  const { user, refreshUser, setBudget, signOut, unlockedKey, unlockAgent, lockAgent } = useAuth();
  const { address: walletAddr, isConnected } = useAccount();
  const navigate = useNavigate();

  const [showKeyModal, setShowKeyModal]     = useState(false);
  const [showDeposit, setShowDeposit]       = useState(false);
  const [showBudget, setShowBudget]         = useState(false);
  const [budgetInput, setBudgetInput]       = useState("");
  const [budgetBusy, setBudgetBusy]         = useState(false);
  const [hireTask, setHireTask]             = useState("price_feed");
  const [hiring, setHiring]                 = useState(false);
  const [hireResult, setHireResult]         = useState<any>(null);
  const [hireError, setHireError]           = useState("");
  const [copiedAddr, setCopied]             = useState(false);

  if (!user) { navigate("/"); return null; }

  const storedMeta = (() => { try { return JSON.parse(localStorage.getItem(AGENT_KEY_STORE) || "{}"); } catch { return {}; } })();
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

  const handleHire = async () => {
    setHiring(true); setHireError(""); setHireResult(null);
    try {
      const body: Record<string, unknown> = { service_type: hireTask, params: {}, auto_select: true };
      if (unlockedKey) body.agent_private_key = unlockedKey;
      const r = await axios.post(`${API}/api/user-agent/hire`, body);
      setHireResult(r.data);
      await refreshUser();
    } catch (e: any) {
      const d = e?.response?.data?.detail;
      setHireError(typeof d === "object" ? d.message || JSON.stringify(d) : d || e.message || "Hire failed");
    } finally { setHiring(false); }
  };

  const copyAddr = (addr: string) => {
    navigator.clipboard.writeText(addr);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <>
      {showKeyModal && <AgentKeyModal onClose={() => setShowKeyModal(false)} />}
      {showDeposit  && <DepositModal onClose={() => setShowDeposit(false)} />}

      <div className="max-w-2xl mx-auto space-y-6">

        {/* ── Page header ── */}
        <div>
          <h1 className="text-xl font-bold" style={{ color: "var(--text-primary)" }}>My Profile</h1>
          <p className="text-xs mt-0.5" style={{ color: "var(--text-muted)" }}>Manage your agent, wallet, and budget</p>
        </div>

        {/* ── Identity card ── */}
        <div className="rounded-2xl p-5 flex flex-col gap-3"
          style={{ background: "var(--surface)", border: "1px solid var(--border)" }}>
          <div className="text-xs font-semibold uppercase tracking-wider" style={{ color: "var(--text-muted)" }}>Identity</div>
          <div className="flex items-center gap-3">
            {user.avatar_url
              ? <img src={user.avatar_url} className="w-12 h-12 rounded-full" alt="" />
              : <div className="w-12 h-12 rounded-full flex items-center justify-center text-2xl"
                  style={{ background: "rgba(0,180,216,0.15)" }}>🤖</div>
            }
            <div>
              <div className="font-semibold text-sm" style={{ color: "var(--text-primary)" }}>{user.name || "—"}</div>
              {user.email && <div className="text-xs" style={{ color: "var(--text-muted)" }}>{user.email}</div>}
              <div className="text-xs mt-0.5" style={{ color: "var(--text-muted)" }}>
                {user.email ? "Google account" : "Wallet account"}
              </div>
            </div>
          </div>
          {/* Web3 wallet address */}
          {isConnected && walletAddr && (
            <div className="rounded-xl p-3 flex items-center justify-between gap-2"
              style={{ background: "rgba(255,255,255,0.04)", border: "1px solid var(--border)" }}>
              <div>
                <div className="text-xs" style={{ color: "var(--text-muted)" }}>Connected wallet</div>
                <code className="text-xs" style={{ color: "var(--text-primary)", fontFamily: "monospace" }}>
                  {walletAddr.slice(0, 10)}…{walletAddr.slice(-6)}
                </code>
              </div>
              <a href={`https://testnet.arcscan.app/address/${walletAddr}`} target="_blank" rel="noreferrer"
                className="text-xs" style={{ color: "var(--accent)" }}>ArcScan ↗</a>
            </div>
          )}
          <button onClick={signOut} className="text-xs w-fit px-3 py-1.5 rounded-xl"
            style={{ background: "rgba(255,60,60,0.1)", color: "#ff8080", border: "1px solid rgba(255,60,60,0.2)" }}>
            Sign out
          </button>
        </div>

        {/* ── Agent card ── */}
        <div className="rounded-2xl p-5 flex flex-col gap-4"
          style={{ background: "var(--surface)", border: "1px solid var(--border)" }}>
          <div className="flex items-center justify-between">
            <div className="text-xs font-semibold uppercase tracking-wider" style={{ color: "var(--text-muted)" }}>Agent</div>
            {user.agent_address && (
              <span className="text-xs px-2 py-0.5 rounded-full"
                style={{ background: unlockedKey ? "rgba(74,222,128,0.12)" : "rgba(255,255,255,0.06)",
                  color: unlockedKey ? "#4ade80" : "var(--text-muted)",
                  border: `1px solid ${unlockedKey ? "rgba(74,222,128,0.3)" : "rgba(255,255,255,0.1)"}` }}>
                {unlockedKey ? "🔓 Unlocked" : "🔒 Locked"}
              </span>
            )}
          </div>

          {user.agent_address ? (<>
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl flex items-center justify-center text-lg shrink-0"
                style={{ background: "rgba(0,180,216,0.12)", border: "1px solid rgba(0,180,216,0.2)" }}>🤖</div>
              <div className="flex-1 min-w-0">
                <div className="font-semibold text-sm" style={{ color: "var(--text-primary)" }}>{agentDisplayName}</div>
                <div className="flex items-center gap-1.5 mt-0.5">
                  <code className="text-xs" style={{ color: "var(--text-muted)", fontFamily: "monospace" }}>
                    {user.agent_address.slice(0, 10)}…{user.agent_address.slice(-6)}
                  </code>
                  <button onClick={() => copyAddr(user.agent_address!)} className="text-xs"
                    style={{ color: "var(--text-muted)" }} title="Copy">
                    {copiedAddr ? "✓" : "⎘"}
                  </button>
                  <a href={`https://testnet.arcscan.app/address/${user.agent_address}`} target="_blank" rel="noreferrer"
                    className="text-xs" style={{ color: "var(--accent)" }}>↗</a>
                </div>
              </div>
            </div>

            {/* Unlock / Lock */}
            {unlockedKey ? (
              <div className="flex items-center justify-between rounded-xl p-3"
                style={{ background: "rgba(74,222,128,0.06)", border: "1px solid rgba(74,222,128,0.2)" }}>
                <p className="text-xs" style={{ color: "#4ade80" }}>
                  Agent unlocked — payments route through your own Circle Gateway balance
                </p>
                <button onClick={lockAgent} className="text-xs px-2 py-1 rounded-lg ml-3 shrink-0"
                  style={{ background: "rgba(255,60,60,0.1)", color: "#ff8080" }}>Lock</button>
              </div>
            ) : (
              <div className="flex flex-col gap-1.5">
                <div className="text-xs" style={{ color: "var(--text-muted)" }}>
                  Unlock to pay from your own Circle Gateway balance (session only — key stays in memory)
                </div>
                <UnlockRow onUnlock={unlockAgent} />
              </div>
            )}
          </>) : (
            <div className="flex flex-col gap-3">
              <p className="text-xs" style={{ color: "var(--text-muted)" }}>
                No agent yet. Create one to start hiring services and making payments on your behalf.
              </p>
              <button onClick={() => setShowKeyModal(true)} className="text-sm px-4 py-2.5 rounded-xl font-semibold w-fit"
                style={{ background: "var(--accent)", color: "#000" }}>
                Create My Agent →
              </button>
            </div>
          )}
        </div>

        {/* ── Fund agent ── */}
        {user.agent_address && (
          <div className="rounded-2xl p-5 flex flex-col gap-4"
            style={{ background: "var(--surface)", border: "1px solid var(--border)" }}>
            <div className="text-xs font-semibold uppercase tracking-wider" style={{ color: "var(--text-muted)" }}>Fund Agent</div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {/* Step 1: USDC faucet */}
              <div className="rounded-xl p-3 flex flex-col gap-2"
                style={{ background: "rgba(0,180,216,0.05)", border: "1px solid rgba(0,180,216,0.15)" }}>
                <div className="text-xs font-medium" style={{ color: "var(--text-primary)" }}>Step 1 — Get USDC</div>
                <p className="text-xs" style={{ color: "var(--text-muted)" }}>
                  Claim testnet USDC at Circle faucet using your agent address.
                </p>
                <div className="flex items-center gap-1.5 flex-wrap">
                  <code className="text-xs px-2 py-0.5 rounded-lg cursor-pointer" onClick={() => copyAddr(user.agent_address!)}
                    style={{ background: "rgba(255,255,255,0.06)", color: "var(--text-primary)", fontFamily: "monospace" }}>
                    {user.agent_address.slice(0, 8)}…{user.agent_address.slice(-6)} {copiedAddr ? "✓" : "⎘"}
                  </code>
                </div>
                <a href="https://faucet.circle.com" target="_blank" rel="noreferrer"
                  className="text-xs px-3 py-1.5 rounded-lg w-fit font-medium"
                  style={{ background: "rgba(0,180,216,0.15)", color: "var(--accent)", border: "1px solid rgba(0,180,216,0.3)", textDecoration: "none" }}>
                  faucet.circle.com ↗
                </a>
              </div>

              {/* Step 2: Gateway deposit */}
              <div className="rounded-xl p-3 flex flex-col gap-2"
                style={{ background: "rgba(0,180,216,0.05)", border: "1px solid rgba(0,180,216,0.15)" }}>
                <div className="text-xs font-medium" style={{ color: "var(--text-primary)" }}>Step 2 — Deposit to Gateway</div>
                <p className="text-xs" style={{ color: "var(--text-muted)" }}>
                  Move USDC from your agent wallet into Circle Gateway for x402 payments.
                </p>
                <button onClick={() => setShowDeposit(true)}
                  className="text-xs px-3 py-1.5 rounded-lg w-fit font-semibold"
                  style={{ background: "var(--accent)", color: "#000" }}>
                  Deposit to Gateway →
                </button>
              </div>
            </div>
          </div>
        )}

        {/* ── TRID Budget ── */}
        {user.agent_address && (
          <div className="rounded-2xl p-5 flex flex-col gap-4"
            style={{ background: "var(--surface)", border: "1px solid var(--border)" }}>
            <div className="flex items-center justify-between">
              <div className="text-xs font-semibold uppercase tracking-wider" style={{ color: "var(--text-muted)" }}>TRID Budget</div>
              <button onClick={() => setShowBudget(b => !b)}
                className="text-xs px-3 py-1 rounded-lg"
                style={{ background: "rgba(0,180,216,0.12)", color: "var(--accent)" }}>
                {showBudget ? "Cancel" : "Edit budget"}
              </button>
            </div>

            <div className="flex items-center gap-5">
              {/* Ring */}
              <div className="relative w-20 h-20 shrink-0">
                <svg viewBox="0 0 48 48" className="w-full h-full -rotate-90">
                  <circle cx="24" cy="24" r="20" fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth="4" />
                  <circle cx="24" cy="24" r="20" fill="none" stroke="var(--accent)" strokeWidth="4"
                    strokeLinecap="round" strokeDasharray={`${pctUsed * 1.257} 125.7`} />
                </svg>
                <div className="absolute inset-0 flex items-center justify-center text-sm font-bold"
                  style={{ color: "var(--accent)" }}>{Math.round(pctUsed)}%</div>
              </div>
              <div>
                <div className="text-2xl font-bold" style={{ color: "var(--text-primary)" }}>
                  {remainTrid.toFixed(4)} <span className="text-sm font-normal" style={{ color: "var(--text-muted)" }}>TRID remaining</span>
                </div>
                <div className="text-xs mt-1" style={{ color: "var(--text-muted)" }}>
                  {spentTrid.toFixed(4)} spent · {budgetTrid.toFixed(4)} total budget
                </div>
                <div className="text-xs mt-0.5" style={{ color: "var(--text-muted)" }}>
                  ≈ ${(remainTrid * 0.001).toFixed(4)} USDC equivalent
                </div>
              </div>
            </div>

            {showBudget && (
              <div className="flex gap-2">
                <input type="number" min="0" step="1" value={budgetInput} onChange={e => setBudgetInput(e.target.value)}
                  placeholder="New budget in TRID (e.g. 100)"
                  className="flex-1 px-3 py-2 rounded-xl text-sm outline-none"
                  style={{ background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.12)", color: "var(--text-primary)" }} />
                <button onClick={handleBudgetSave} disabled={budgetBusy}
                  className="px-4 py-2 rounded-xl text-sm font-semibold"
                  style={{ background: "var(--accent)", color: "#000" }}>
                  {budgetBusy ? "…" : "Save"}
                </button>
              </div>
            )}
          </div>
        )}

        {/* ── Auto-hire ── */}
        {user.agent_address && user.max_trid_budget > 0 && (
          <div className="rounded-2xl p-5 flex flex-col gap-4"
            style={{ background: "var(--surface)", border: "1px solid var(--border)" }}>
            <div className="text-xs font-semibold uppercase tracking-wider" style={{ color: "var(--text-muted)" }}>Auto-hire a service</div>

            <div className="flex gap-2">
              <select value={hireTask} onChange={e => setHireTask(e.target.value)}
                className="flex-1 px-3 py-2 rounded-xl text-sm outline-none"
                style={{ background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.12)", color: "var(--text-primary)" }}>
                <option value="price_feed">Price Feed</option>
                <option value="fx_rates">FX Rates</option>
                <option value="risk_score">Risk Score</option>
                <option value="compute_score">Portfolio Score</option>
                <option value="retrobot_audit">Retrobot Audit</option>
              </select>
              <button onClick={handleHire} disabled={hiring}
                className="px-4 py-2 rounded-xl text-sm font-semibold shrink-0"
                style={{ background: "var(--accent)", color: "#000" }}>
                {hiring ? "⏳" : "Auto-hire"}
              </button>
            </div>

            {!unlockedKey && (
              <p className="text-xs" style={{ color: "var(--text-muted)", opacity: 0.7 }}>
                Unlock your agent above to pay from your own Gateway balance.
              </p>
            )}

            {hireResult && (
              <div className="rounded-xl p-3 text-xs flex flex-col gap-1"
                style={{ background: "rgba(0,255,120,0.06)", border: "1px solid rgba(0,255,120,0.2)" }}>
                <div className="font-semibold" style={{ color: "#4ade80" }}>
                  ✓ Hired {hireResult.agent_used?.name}
                </div>
                <div style={{ color: "var(--text-muted)" }}>
                  Paid {hireResult.payment?.trid_display}
                  {hireResult.payment?.usdc_gateway && ` + ${hireResult.payment.usdc_gateway} USDC via Gateway`}
                </div>
                {hireResult.payment?.payment_source === "user_agent" && (
                  <div style={{ color: "#4ade80" }}>💳 From your own Circle Gateway balance</div>
                )}
                <div style={{ color: "var(--text-muted)" }}>
                  Budget remaining: {hireResult.budget?.remaining_display}
                </div>
              </div>
            )}

            {hireError && <p className="text-xs text-red-400">{hireError}</p>}
          </div>
        )}

      </div>
    </>
  );
}
