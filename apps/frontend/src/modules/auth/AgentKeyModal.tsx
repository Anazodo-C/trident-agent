/**
 * AgentKeyModal — one-time private key display shown immediately after agent creation.
 *
 * Steps:
 *  1. "name"    — user picks a name for their agent
 *  2. "loading" — generate key via Node backend
 *  3. "display" — show private key (must copy + check box before proceeding)
 *  4. "encrypt" — user sets a passphrase; key stored AES-256 in localStorage
 *  5. "done"    — all set
 */
import { useState, useCallback } from "react";
import axios from "axios";
import { useAuth } from "./AuthContext";

const API      = import.meta.env.VITE_API_URL      || "https://backend-production-149a.up.railway.app";
const NODE_API = import.meta.env.VITE_NODE_API_URL || "http://localhost:3001";
export const AGENT_KEY_STORE = "trident_agent_key"; // exported so MyAgentPanel can read it

// ── Encrypt using Web Crypto (AES-GCM, passphrase-derived key) ────────────────
async function deriveKey(passphrase: string, salt: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    "raw", enc.encode(passphrase), "PBKDF2", false, ["deriveKey"]
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: 100_000, hash: "SHA-256" },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export async function decryptAgentKey(passphrase: string): Promise<{ privateKey: string; address: string } | null> {
  const raw = localStorage.getItem(AGENT_KEY_STORE);
  if (!raw) return null;
  try {
    const { encrypted, address } = JSON.parse(raw);
    const buf  = Uint8Array.from(atob(encrypted), c => c.charCodeAt(0));
    const salt = buf.slice(0, 16) as unknown as Uint8Array<ArrayBuffer>;
    const iv   = buf.slice(16, 28) as unknown as Uint8Array<ArrayBuffer>;
    const ct   = buf.slice(28);
    const key  = await deriveKey(passphrase, salt);
    const dec  = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
    const privateKey = new TextDecoder().decode(dec);
    return { privateKey, address };
  } catch {
    return null; // wrong passphrase or corrupted
  }
}

async function encryptKey(privateKey: string, passphrase: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16)) as Uint8Array<ArrayBuffer>;
  const iv   = crypto.getRandomValues(new Uint8Array(12)) as Uint8Array<ArrayBuffer>;
  const key  = await deriveKey(passphrase, salt);
  const enc  = new TextEncoder();
  const ct   = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(privateKey));
  const buf  = new Uint8Array(salt.length + iv.length + ct.byteLength);
  buf.set(salt, 0);
  buf.set(iv, 16);
  buf.set(new Uint8Array(ct), 28);
  return btoa(String.fromCharCode(...buf));
}

interface AgentKeyModalProps {
  onClose: () => void;
}

type Step = "name" | "loading" | "display" | "encrypt" | "done";

export default function AgentKeyModal({ onClose }: AgentKeyModalProps) {
  const { refreshUser } = useAuth();

  const [step, setStep]           = useState<Step>("name");
  const [agentName, setAgentName] = useState("");
  const [agentData, setAgentData] = useState<{ address: string; privateKey: string } | null>(null);
  const [copied, setCopied]       = useState(false);
  const [passphrase, setPassphrase]   = useState("");
  const [passConfirm, setPassConfirm] = useState("");
  const [passphraseError, setPassphraseError] = useState("");
  const [checkedSaved, setCheckedSaved] = useState(false);
  const [encrypting, setEncrypting] = useState(false);
  const [error, setError]           = useState("");

  // Step 2: generate agent key (called after user sets name)
  const generateKey = useCallback(async () => {
    setStep("loading");
    try {
      const r = await axios.post(`${NODE_API}/auth/create-agent`);
      const { address, privateKey } = r.data;
      setAgentData({ address, privateKey });
      // Register address + name in backend
      await axios.put(`${API}/auth/me/agent`, {
        agent_address: address,
        agent_name: agentName.trim() || undefined,
      });
      await refreshUser();
      setStep("display");
    } catch (e: any) {
      setError(e?.response?.data?.error || e.message || "Failed to create agent");
      setStep("display");
    }
  }, [agentName, refreshUser]);

  const copyKey = () => {
    if (!agentData) return;
    navigator.clipboard.writeText(agentData.privateKey);
    setCopied(true);
    setTimeout(() => setCopied(false), 2500);
  };

  const handleEncrypt = useCallback(async () => {
    if (!agentData) return;
    if (passphrase.length < 8) {
      setPassphraseError("Passphrase must be at least 8 characters");
      return;
    }
    if (passphrase !== passConfirm) {
      setPassphraseError("Passphrases do not match");
      return;
    }
    setEncrypting(true);
    try {
      const encrypted = await encryptKey(agentData.privateKey, passphrase);
      localStorage.setItem(AGENT_KEY_STORE, JSON.stringify({
        address: agentData.address,
        name: agentName.trim() || "My Agent",
        encrypted,
        createdAt: Date.now(),
      }));
      setStep("done");
    } catch (e: any) {
      setPassphraseError("Encryption failed: " + e.message);
    } finally {
      setEncrypting(false);
    }
  }, [agentData, agentName, passphrase, passConfirm]);

  return (
    <div
      className="fixed inset-0 z-[300] flex items-center justify-center p-4"
      style={{ background: "rgba(0,0,0,0.85)", backdropFilter: "blur(8px)" }}
    >
      <div
        className="w-full max-w-lg rounded-2xl p-6 flex flex-col gap-5"
        style={{
          background: "var(--surface)",
          border: "1px solid rgba(255,60,60,0.35)",
          boxShadow: "0 0 40px rgba(255,60,60,0.12)",
        }}
      >

        {/* ── Step 1: Choose agent name ── */}
        {step === "name" && (
          <>
            <div className="flex items-start gap-3">
              <span className="text-2xl">🤖</span>
              <div>
                <h2 className="text-base font-bold" style={{ color: "var(--text-primary)" }}>
                  Name your agent
                </h2>
                <p className="text-xs mt-0.5" style={{ color: "var(--text-muted)" }}>
                  Give your agent a unique identity on the Trident marketplace.
                </p>
              </div>
            </div>

            <div>
              <label className="text-xs mb-1 block" style={{ color: "var(--text-muted)" }}>Agent name</label>
              <input
                type="text"
                value={agentName}
                onChange={e => setAgentName(e.target.value)}
                placeholder="e.g. NovaScan, DeltaBot, MyTrader…"
                maxLength={40}
                className="w-full px-3 py-2 rounded-xl text-sm outline-none"
                style={{
                  background: "rgba(255,255,255,0.06)",
                  border: "1px solid rgba(255,255,255,0.12)",
                  color: "var(--text-primary)",
                }}
                onKeyDown={e => e.key === "Enter" && agentName.trim() && generateKey()}
              />
              <p className="text-xs mt-1" style={{ color: "var(--text-muted)", opacity: 0.6 }}>
                This name appears on the marketplace and leaderboard.
              </p>
            </div>

            <button
              onClick={generateKey}
              disabled={!agentName.trim()}
              className="w-full py-2.5 rounded-xl text-sm font-semibold transition-opacity"
              style={{
                background: agentName.trim() ? "var(--accent)" : "rgba(255,255,255,0.1)",
                color: agentName.trim() ? "#000" : "var(--text-muted)",
                opacity: agentName.trim() ? 1 : 0.5,
              }}
            >
              Create Agent →
            </button>
          </>
        )}

        {/* ── Step 2: Loading / generating ── */}
        {step === "loading" && (
          <div className="text-center py-8">
            <div className="text-3xl mb-3">⚙️</div>
            <p style={{ color: "var(--text-muted)" }}>Generating wallet for <strong>{agentName}</strong>…</p>
            {error && <p className="text-red-400 text-sm mt-2">{error}</p>}
          </div>
        )}

        {/* ── Step 3: Display key ── */}
        {step === "display" && agentData && (
          <>
            <div className="flex items-start gap-3">
              <span className="text-2xl">🔑</span>
              <div>
                <h2 className="text-base font-bold" style={{ color: "var(--text-primary)" }}>
                  {agentName}'s Private Key
                </h2>
                <p className="text-xs mt-0.5" style={{ color: "var(--text-muted)" }}>
                  This is the only time you will ever see this key.
                </p>
              </div>
            </div>

            <div
              className="rounded-xl p-3 text-xs leading-relaxed"
              style={{ background: "rgba(255,60,60,0.1)", border: "1px solid rgba(255,60,60,0.3)", color: "#ff8080" }}
            >
              ⚠️ <strong>CRITICAL:</strong> Copy and store this key — a password manager, encrypted file, or written offline. Trident never stores it. If you lose it, your agent wallet is gone forever.
            </div>

            <div>
              <p className="text-xs mb-1" style={{ color: "var(--text-muted)" }}>Agent Address (public)</p>
              <code
                className="block text-xs p-2 rounded-lg break-all"
                style={{ background: "rgba(255,255,255,0.05)", color: "var(--text-primary)" }}
              >
                {agentData.address}
              </code>
            </div>

            <div>
              <p className="text-xs mb-1" style={{ color: "var(--text-muted)" }}>Private Key — KEEP SECRET</p>
              <div className="relative">
                <code
                  className="block text-xs p-3 rounded-lg break-all pr-20"
                  style={{ background: "rgba(255,60,60,0.07)", border: "1px solid rgba(255,60,60,0.2)", color: "#ff8080", fontFamily: "monospace" }}
                >
                  {agentData.privateKey}
                </code>
                <button
                  onClick={copyKey}
                  className="absolute right-2 top-2 text-xs px-2 py-1 rounded-lg"
                  style={{ background: "rgba(255,255,255,0.1)", color: "var(--text-primary)" }}
                >
                  {copied ? "✓ Copied" : "Copy"}
                </button>
              </div>
            </div>

            <label className="flex items-start gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={checkedSaved}
                onChange={e => setCheckedSaved(e.target.checked)}
                className="mt-0.5 shrink-0"
              />
              <span className="text-xs" style={{ color: "var(--text-muted)" }}>
                I have saved my private key securely. I understand it cannot be recovered if lost.
              </span>
            </label>

            <button
              onClick={() => setStep("encrypt")}
              disabled={!checkedSaved}
              className="w-full py-2.5 rounded-xl text-sm font-semibold transition-opacity"
              style={{
                background: checkedSaved ? "var(--accent)" : "rgba(255,255,255,0.1)",
                color: checkedSaved ? "#000" : "var(--text-muted)",
                opacity: checkedSaved ? 1 : 0.5,
              }}
            >
              Continue — Encrypt & Store Locally →
            </button>
          </>
        )}

        {/* ── Step 4: Passphrase encryption ── */}
        {step === "encrypt" && (
          <>
            <div className="flex items-start gap-3">
              <span className="text-2xl">🔒</span>
              <div>
                <h2 className="text-base font-bold" style={{ color: "var(--text-primary)" }}>
                  Encrypt Your Key
                </h2>
                <p className="text-xs mt-0.5" style={{ color: "var(--text-muted)" }}>
                  Encrypted with AES-256 and stored only in your browser. We never see it.
                </p>
              </div>
            </div>

            <div className="flex flex-col gap-3">
              <div>
                <label className="text-xs mb-1 block" style={{ color: "var(--text-muted)" }}>Passphrase (min 8 chars)</label>
                <input
                  type="password"
                  value={passphrase}
                  onChange={e => { setPassphrase(e.target.value); setPassphraseError(""); }}
                  placeholder="Choose a strong passphrase…"
                  className="w-full px-3 py-2 rounded-xl text-sm outline-none"
                  style={{ background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.12)", color: "var(--text-primary)" }}
                />
              </div>
              <div>
                <label className="text-xs mb-1 block" style={{ color: "var(--text-muted)" }}>Confirm passphrase</label>
                <input
                  type="password"
                  value={passConfirm}
                  onChange={e => { setPassConfirm(e.target.value); setPassphraseError(""); }}
                  placeholder="Repeat passphrase…"
                  className="w-full px-3 py-2 rounded-xl text-sm outline-none"
                  style={{ background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.12)", color: "var(--text-primary)" }}
                />
              </div>
              {passphraseError && (
                <p className="text-xs text-red-400">{passphraseError}</p>
              )}
            </div>

            <button
              onClick={handleEncrypt}
              disabled={encrypting || !passphrase || !passConfirm}
              className="w-full py-2.5 rounded-xl text-sm font-semibold"
              style={{ background: "var(--accent)", color: "#000" }}
            >
              {encrypting ? "Encrypting…" : "Encrypt & Save to Browser"}
            </button>
          </>
        )}

        {/* ── Step 5: Done ── */}
        {step === "done" && (
          <>
            <div className="text-center py-4">
              <div className="text-4xl mb-3">✅</div>
              <h2 className="text-base font-bold mb-1" style={{ color: "var(--text-primary)" }}>
                {agentName} is ready
              </h2>
              <p className="text-xs" style={{ color: "var(--text-muted)" }}>
                Key encrypted in your browser. Next: fund your agent with USDC so it can make Circle Gateway payments.
              </p>
            </div>
            <button
              onClick={onClose}
              className="w-full py-2.5 rounded-xl text-sm font-semibold"
              style={{ background: "var(--accent)", color: "#000" }}
            >
              Fund & Configure Agent →
            </button>
          </>
        )}
      </div>
    </div>
  );
}
