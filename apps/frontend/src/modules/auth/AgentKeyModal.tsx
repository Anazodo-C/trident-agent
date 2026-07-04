/**
 * AgentKeyModal — one-time private key display shown immediately after agent creation.
 *
 * - Shows the raw private key with copy button
 * - Encrypts it with a user-chosen passphrase → stores ciphertext in localStorage
 * - Once user confirms, key is gone from memory — never shown again
 * - Calls PUT /auth/me/agent to register the address in the backend
 */
import { useState, useCallback, useEffect } from "react";
import axios from "axios";
import { useAuth } from "./AuthContext";

const API = import.meta.env.VITE_API_URL || "https://backend-production-149a.up.railway.app";
const NODE_API = import.meta.env.VITE_NODE_API_URL || "http://localhost:3001";
const AGENT_KEY_STORE = "trident_agent_key"; // localStorage key for encrypted key

// ── Encrypt / decrypt using Web Crypto (AES-GCM, passphrase-derived key) ────
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

async function encryptKey(privateKey: string, passphrase: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16)) as Uint8Array<ArrayBuffer>;
  const iv   = crypto.getRandomValues(new Uint8Array(12)) as Uint8Array<ArrayBuffer>;
  const key  = await deriveKey(passphrase, salt);
  const enc  = new TextEncoder();
  const ct   = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(privateKey));
  // Pack: salt(16) + iv(12) + ciphertext → base64
  const buf = new Uint8Array(salt.length + iv.length + ct.byteLength);
  buf.set(salt, 0);
  buf.set(iv, 16);
  buf.set(new Uint8Array(ct), 28);
  return btoa(String.fromCharCode(...buf));
}

interface AgentKeyModalProps {
  onClose: () => void;
}

type Step = "loading" | "display" | "encrypt" | "done";

export default function AgentKeyModal({ onClose }: AgentKeyModalProps) {
  const { refreshUser } = useAuth();
  const [step, setStep]         = useState<Step>("loading");
  const [agentData, setAgentData] = useState<{ address: string; privateKey: string } | null>(null);
  const [copied, setCopied]     = useState(false);
  const [passphrase, setPassphrase] = useState("");
  const [passConfirm, setPassConfirm] = useState("");
  const [passphraseError, setPassphraseError] = useState("");
  const [checkedSaved, setCheckedSaved] = useState(false);
  const [encrypting, setEncrypting] = useState(false);
  const [error, setError]       = useState("");

  // Generate agent key on mount
  useEffect(() => {
    axios.post(`${NODE_API}/auth/create-agent`)
      .then(async r => {
        const { address, privateKey } = r.data;
        setAgentData({ address, privateKey });
        // Register address in backend
        await axios.put(`${API}/auth/me/agent`, { agent_address: address });
        await refreshUser();
        setStep("display");
      })
      .catch(e => {
        setError(e?.response?.data?.error || e.message || "Failed to create agent");
        setStep("display");
      });
  }, []);

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
        encrypted,
        createdAt: Date.now(),
      }));
      setStep("done");
    } catch (e: any) {
      setPassphraseError("Encryption failed: " + e.message);
    } finally {
      setEncrypting(false);
    }
  }, [agentData, passphrase, passConfirm]);

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
        {/* ── Loading ── */}
        {step === "loading" && (
          <div className="text-center py-8">
            <div className="text-3xl mb-3">⚙️</div>
            <p style={{ color: "var(--text-muted)" }}>Creating your agent wallet…</p>
            {error && <p className="text-red-400 text-sm mt-2">{error}</p>}
          </div>
        )}

        {/* ── Display key ── */}
        {step === "display" && agentData && (
          <>
            <div className="flex items-start gap-3">
              <span className="text-2xl">🔑</span>
              <div>
                <h2 className="text-base font-bold" style={{ color: "var(--text-primary)" }}>
                  Your Agent Private Key
                </h2>
                <p className="text-xs mt-0.5" style={{ color: "var(--text-muted)" }}>
                  This is the only time you will ever see this key.
                </p>
              </div>
            </div>

            {/* Warning banner */}
            <div
              className="rounded-xl p-3 text-xs leading-relaxed"
              style={{ background: "rgba(255,60,60,0.1)", border: "1px solid rgba(255,60,60,0.3)", color: "#ff8080" }}
            >
              ⚠️ <strong>CRITICAL:</strong> Copy and store this key somewhere safe — a password manager, encrypted file, or written offline. Trident never stores it. If you lose it, your agent wallet and all its TRID are gone forever.
            </div>

            {/* Agent address */}
            <div>
              <p className="text-xs mb-1" style={{ color: "var(--text-muted)" }}>Agent Address (public)</p>
              <code
                className="block text-xs p-2 rounded-lg break-all"
                style={{ background: "rgba(255,255,255,0.05)", color: "var(--text-primary)" }}
              >
                {agentData.address}
              </code>
            </div>

            {/* Private key */}
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

        {/* ── Passphrase encryption ── */}
        {step === "encrypt" && (
          <>
            <div className="flex items-start gap-3">
              <span className="text-2xl">🔒</span>
              <div>
                <h2 className="text-base font-bold" style={{ color: "var(--text-primary)" }}>
                  Encrypt Your Key
                </h2>
                <p className="text-xs mt-0.5" style={{ color: "var(--text-muted)" }}>
                  Your key will be encrypted with AES-256 and stored only in your browser. We never see it.
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

        {/* ── Done ── */}
        {step === "done" && (
          <>
            <div className="text-center py-4">
              <div className="text-4xl mb-3">✅</div>
              <h2 className="text-base font-bold mb-1" style={{ color: "var(--text-primary)" }}>
                Agent Ready
              </h2>
              <p className="text-xs" style={{ color: "var(--text-muted)" }}>
                Your agent key is encrypted and stored locally. Set a TRID budget to let it start hiring services.
              </p>
            </div>
            <button
              onClick={onClose}
              className="w-full py-2.5 rounded-xl text-sm font-semibold"
              style={{ background: "var(--accent)", color: "#000" }}
            >
              Go to My Agent →
            </button>
          </>
        )}
      </div>
    </div>
  );
}
