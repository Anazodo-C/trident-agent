/**
 * AuthPage — Sign in with Google (Web2) or connect wallet (Web3).
 * After first sign-in, if no agent exists → show AgentKeyModal.
 */
import { useState, useCallback } from "react";
import { ConnectButton } from "@rainbow-me/rainbowkit";
import { useAccount } from "wagmi";
import { GoogleLogin, type CredentialResponse } from "@react-oauth/google";
import { useAuth } from "./AuthContext";
import AgentKeyModal from "./AgentKeyModal";

export default function AuthPage() {
  const { user, loading, signInWithGoogle, signInWithWallet } = useAuth();
  const { isConnected } = useAccount();
  const [showKeyModal, setShowKeyModal] = useState(false);
  const [error, setError]               = useState("");
  const [busy, setBusy]                 = useState(false);

  const handleGoogle = useCallback(async (cred: CredentialResponse) => {
    if (!cred.credential) return;
    setBusy(true);
    setError("");
    try {
      await signInWithGoogle(cred.credential);
      // If newly created agent → show key modal (checked in MyAgentPanel)
    } catch (e: any) {
      setError(e?.response?.data?.detail || e.message || "Google sign-in failed");
    } finally {
      setBusy(false);
    }
  }, [signInWithGoogle]);

  const handleWallet = useCallback(async () => {
    if (!isConnected) { setError("Connect your wallet first"); return; }
    setBusy(true);
    setError("");
    try {
      await signInWithWallet();
    } catch (e: any) {
      setError(e?.response?.data?.detail || e.message || "Wallet sign-in failed");
    } finally {
      setBusy(false);
    }
  }, [isConnected, signInWithWallet]);

  if (loading) return null;
  if (user && !showKeyModal) return null; // already signed in — render nothing (App handles routing)

  return (
    <>
      {showKeyModal && <AgentKeyModal onClose={() => setShowKeyModal(false)} />}

      <div
        className="min-h-screen flex flex-col items-center justify-center p-6"
        style={{ background: "var(--bg)" }}
      >
        <div
          className="w-full max-w-sm rounded-2xl p-8 flex flex-col gap-6"
          style={{
            background: "var(--surface)",
            border: "1px solid rgba(0,180,216,0.2)",
            boxShadow: "0 0 40px rgba(0,180,216,0.06)",
          }}
        >
          {/* Logo */}
          <div className="text-center">
            <div className="text-4xl mb-2">🔱</div>
            <h1 className="text-xl font-bold" style={{ color: "var(--text-primary)" }}>
              Trident Agent
            </h1>
            <p className="text-xs mt-1" style={{ color: "var(--text-muted)" }}>
              Financial intelligence marketplace on Arc Testnet
            </p>
          </div>

          {/* Divider */}
          <div className="flex items-center gap-3">
            <div style={{ flex: 1, height: 1, background: "rgba(255,255,255,0.07)" }} />
            <span className="text-xs" style={{ color: "var(--text-muted)" }}>Sign in to get your agent</span>
            <div style={{ flex: 1, height: 1, background: "rgba(255,255,255,0.07)" }} />
          </div>

          {/* Google Sign-In */}
          <div className="flex flex-col gap-3">
            <p className="text-xs text-center" style={{ color: "var(--text-muted)" }}>Web2</p>
            <div className="flex justify-center">
              <GoogleLogin
                onSuccess={handleGoogle}
                onError={() => setError("Google sign-in failed")}
                theme="filled_black"
                shape="pill"
                text="signin_with"
                useOneTap
              />
            </div>
          </div>

          {/* Divider */}
          <div className="flex items-center gap-3">
            <div style={{ flex: 1, height: 1, background: "rgba(255,255,255,0.07)" }} />
            <span className="text-xs" style={{ color: "var(--text-muted)" }}>or</span>
            <div style={{ flex: 1, height: 1, background: "rgba(255,255,255,0.07)" }} />
          </div>

          {/* Wallet Sign-In */}
          <div className="flex flex-col gap-3">
            <p className="text-xs text-center" style={{ color: "var(--text-muted)" }}>Web3</p>
            <ConnectButton />
            {isConnected && (
              <button
                onClick={handleWallet}
                disabled={busy}
                className="w-full py-2.5 rounded-xl text-sm font-semibold transition-opacity"
                style={{ background: "var(--accent)", color: "#000", opacity: busy ? 0.6 : 1 }}
              >
                {busy ? "Signing…" : "Sign in with Wallet"}
              </button>
            )}
          </div>

          {error && (
            <p className="text-xs text-center text-red-400">{error}</p>
          )}

          <p className="text-xs text-center" style={{ color: "var(--text-muted)", opacity: 0.6 }}>
            First sign-in creates your agent wallet. Your private key is yours — we never store it.
          </p>
        </div>
      </div>
    </>
  );
}
