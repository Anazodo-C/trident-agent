import { useState, useEffect, useRef } from "react";
import { useAccount } from "wagmi";
import { ConnectButton } from "@rainbow-me/rainbowkit";
import axios from "axios";

import FaucetModal       from "../../components/FaucetModal";
import OnboardingModal   from "../../components/OnboardingModal";
import UploadAgentModal  from "../../components/UploadAgentModal";
import ServiceResultModal from "../../components/ServiceResultModal";
import { useToast as useToastHook } from "../../components/Toast";
import { useWalletBalance } from "../../hooks/useWalletBalance";

const API      = import.meta.env.VITE_API_URL      || "http://localhost:8000";
const NODE_API = import.meta.env.VITE_NODE_API_URL || "http://localhost:3001";

interface Agent {
  id: number;
  name: string;
  agent_type: string;
  wallet: string;
  reputation_score: number;
  arc_agent_id?: number;
  registered_at?: string;
}

interface Service {
  id: number;
  name: string;
  service_type: string;
  description: string;
  price_per_call: number;
  price_trid_display: string;
  endpoint: string;
  x402_enabled: boolean;
  calls_served: number;
  seller_reputation: number;
  seller_name: string;
  seller_address: string;
}

const TYPE_ICONS: Record<string, string> = {
  price_feed:       "📈",
  fx_rates:         "💱",
  risk_score:       "🛡️",
  research_summary: "🧠",
  compute_score:    "⚙️",
  retrobot_audit:   "🔍",
  retrobot:         "🤖",
  buyer:            "💼",
  seller:           "🏪",
};

const TIER_LABELS: Record<string, string> = {
  Elite: "badge-purple", Premium: "badge-blue", Verified: "badge-green", Basic: "badge-yellow",
};

function tier(score: number) {
  return score >= 8000 ? "Elite" : score >= 6000 ? "Premium" : score >= 4000 ? "Verified" : "Basic";
}

// ── Hire Card ────────────────────────────────────────────────────
function AgentServiceCard({
  svc,
  onResult,
}: {
  svc: Service;
  onResult: (name: string, result: unknown, price: string) => void;
}) {
  const { address, isConnected } = useAccount();
  const { show, dismiss }        = useToastHook();
  const [busy, setBusy]          = useState(false);

  const handleHire = async () => {
    if (!isConnected) {
      show("Connect your wallet to hire agents", "error");
      return;
    }
    setBusy(true);
    const tid = show(`Calling ${svc.name}…`, "loading");
    try {
      // First try x402-enabled endpoint via Node gateway
      const endpoint = svc.endpoint.startsWith("http")
        ? svc.endpoint
        : `${NODE_API}${svc.endpoint}`;

      let result: unknown;
      try {
        const r = await axios.get(endpoint, {
          headers: address ? { "x-buyer-address": address } : {},
          timeout: 8000,
        });
        result = r.data;
      } catch (gateErr: any) {
        // Fall back to Python backend data endpoint
        const fallback = `${API}${svc.endpoint}`;
        const r = await axios.get(fallback, { timeout: 8000 });
        result = r.data;
      }

      dismiss(tid);
      onResult(svc.name, result, svc.price_trid_display);
    } catch (err: any) {
      dismiss(tid);
      show(err?.message || "Service call failed", "error", 4000);
    } finally {
      setBusy(false);
    }
  };

  const t = tier(svc.seller_reputation);

  return (
    <div className="agent-card flex flex-col h-full">
      {/* Top */}
      <div className="flex items-start justify-between mb-3">
        <div className="flex items-center gap-2.5">
          <div
            className="w-10 h-10 rounded-xl flex items-center justify-center text-xl shrink-0"
            style={{ background: "rgba(0,180,216,0.12)", border: "1px solid rgba(0,180,216,0.2)" }}
          >
            {TYPE_ICONS[svc.service_type] || "📊"}
          </div>
          <div>
            <div className="font-semibold text-sm" style={{ color: "var(--text-primary)" }}>
              {svc.name}
            </div>
            <div className="text-xs" style={{ color: "var(--text-muted)" }}>
              {svc.seller_name}
            </div>
          </div>
        </div>
        <span className={`badge ${TIER_LABELS[t]}`}>{t}</span>
      </div>

      {/* Description */}
      <p className="text-xs mb-4 line-clamp-2 flex-1" style={{ color: "var(--text-muted)" }}>
        {svc.description || "Financial intelligence service on Arc Testnet"}
      </p>

      {/* Stats row */}
      <div className="flex items-center gap-3 text-xs mb-4" style={{ color: "var(--text-muted)" }}>
        <span>⚡ {svc.calls_served.toLocaleString()} calls</span>
        <span>🌟 {(svc.seller_reputation / 100).toFixed(0)}%</span>
        {svc.x402_enabled && <span className="badge badge-ocean">x402</span>}
      </div>

      {/* Price + CTA */}
      <div className="flex items-center justify-between">
        <span
          className="mono font-bold text-sm"
          style={{ color: "var(--accent)" }}
        >
          {svc.price_trid_display}
        </span>
        <button
          onClick={handleHire}
          disabled={busy}
          className="btn-primary text-xs py-1.5 px-4"
        >
          {busy ? "Calling…" : "Hire →"}
        </button>
      </div>
    </div>
  );
}

// ── Registered Agent Chip ─────────────────────────────────────────
function AgentChip({ ag }: { ag: Agent }) {
  return (
    <div
      className="flex items-center gap-2.5 rounded-xl px-3 py-2.5 transition-all"
      style={{
        background: "rgba(0,180,216,0.07)",
        border:     "1px solid rgba(0,180,216,0.18)",
      }}
    >
      <div
        className="w-8 h-8 rounded-lg flex items-center justify-center text-base shrink-0"
        style={{ background: "rgba(0,180,216,0.15)" }}
      >
        {TYPE_ICONS[ag.agent_type] || "🤖"}
      </div>
      <div className="min-w-0">
        <div className="text-xs font-semibold truncate" style={{ color: "var(--text-primary)" }}>
          {ag.name}
        </div>
        <div className="text-xs truncate" style={{ color: "var(--text-muted)" }}>
          {ag.wallet.slice(0, 6)}…{ag.wallet.slice(-4)}
          {ag.arc_agent_id ? ` · Arc #${ag.arc_agent_id}` : ""}
        </div>
      </div>
      <div className="ml-auto">
        <span className={`badge ${TIER_LABELS[tier(ag.reputation_score)]}`}>
          {tier(ag.reputation_score)}
        </span>
      </div>
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────────────
const ONBOARDING_KEY = "trident_onboarded";
const FAUCET_KEY     = "trident_faucet_offered";

export default function AgentsPage() {
  const { address, isConnected } = useAccount();
  const balance                  = useWalletBalance();
  const [agents,   setAgents]   = useState<Agent[]>([]);
  const [services, setServices] = useState<Service[]>([]);
  const [filter,   setFilter]   = useState("");
  const [loading,  setLoading]  = useState(true);

  // Modals
  const [showFaucet,    setShowFaucet]    = useState(false);
  const [showOnboarding, setShowOnboarding] = useState(false);
  const [showUpload,    setShowUpload]    = useState(false);
  const [serviceResult, setServiceResult] = useState<{
    name: string; result: unknown; price: string;
  } | null>(null);

  const prevAddr = useRef<string | undefined>(undefined);

  // Onboarding logic: trigger for brand-new wallet connections
  useEffect(() => {
    if (!isConnected || !address) { prevAddr.current = undefined; return; }
    if (prevAddr.current === address) return;
    prevAddr.current = address;

    const faucetOffered    = localStorage.getItem(`${FAUCET_KEY}_${address}`);
    const onboardingShown  = localStorage.getItem(`${ONBOARDING_KEY}_${address}`);

    if (!faucetOffered) {
      localStorage.setItem(`${FAUCET_KEY}_${address}`, "1");
      setShowFaucet(true);
    } else if (!onboardingShown) {
      localStorage.setItem(`${ONBOARDING_KEY}_${address}`, "1");
      setShowOnboarding(true);
    }
  }, [address, isConnected]);

  // Load data
  useEffect(() => {
    const load = async () => {
      try {
        const [agRes, svcRes] = await Promise.all([
          axios.get(`${API}/api/agents/list`),
          axios.get(`${API}/api/marketplace/services`),
        ]);
        setAgents(agRes.data.agents   || []);
        setServices(svcRes.data.services || DEMO_SERVICES);
      } catch {
        setServices(DEMO_SERVICES);
      } finally {
        setLoading(false);
      }
    };
    load();
  }, []);

  const filteredSvc = services.filter(s =>
    !filter ||
    s.name.toLowerCase().includes(filter.toLowerCase()) ||
    s.service_type.includes(filter.toLowerCase())
  );

  // Sort: most calls served = trending first
  const trendingFirst = [...filteredSvc].sort((a, b) => b.calls_served - a.calls_served);

  return (
    <div className="space-y-8">
      {/* ── Modals ── */}
      {showFaucet && (
        <FaucetModal
          onAccept={() => {
            setShowFaucet(false);
            const shown = localStorage.getItem(`${ONBOARDING_KEY}_${address}`);
            if (!shown) {
              localStorage.setItem(`${ONBOARDING_KEY}_${address}`, "1");
              setShowOnboarding(true);
            }
          }}
          onSkip={() => {
            setShowFaucet(false);
            const shown = localStorage.getItem(`${ONBOARDING_KEY}_${address}`);
            if (!shown) {
              localStorage.setItem(`${ONBOARDING_KEY}_${address}`, "1");
              setShowOnboarding(true);
            }
          }}
        />
      )}

      {showOnboarding && (
        <OnboardingModal
          onHire={() => { setShowOnboarding(false); }}
          onUpload={() => { setShowOnboarding(false); setShowUpload(true); }}
          onSkip={() => setShowOnboarding(false)}
        />
      )}

      {showUpload && (
        <UploadAgentModal
          onClose={() => setShowUpload(false)}
          onSuccess={() => {
            setShowUpload(false);
            axios.get(`${API}/api/agents/list`).then(r => setAgents(r.data.agents || [])).catch(() => {});
          }}
        />
      )}

      {serviceResult && (
        <ServiceResultModal
          serviceName={serviceResult.name}
          result={serviceResult.result}
          pricePaid={serviceResult.price}
          onClose={() => setServiceResult(null)}
        />
      )}

      {/* ── Hero ── */}
      <div
        className="rounded-2xl p-8 relative overflow-hidden"
        style={{
          background: "linear-gradient(135deg, rgba(0,150,199,0.18) 0%, rgba(2,62,138,0.12) 100%)",
          border:     "1.5px solid rgba(0,180,216,0.25)",
        }}
      >
        {/* Decorative wave */}
        <div
          className="absolute inset-0 opacity-10 pointer-events-none"
          style={{
            backgroundImage: "radial-gradient(circle at 70% 50%, rgba(0,180,216,0.6) 0%, transparent 60%)",
          }}
        />
        <div className="relative z-10 flex flex-col md:flex-row items-start md:items-center justify-between gap-6">
          <div>
            <div className="flex items-center gap-3 mb-2">
              <span className="text-4xl">🔱</span>
              <h1 className="text-3xl font-bold" style={{ color: "var(--text-primary)" }}>
                Agents
              </h1>
              <span
                className="text-xs px-2.5 py-1 rounded-full font-semibold"
                style={{ background: "rgba(0,180,216,0.2)", color: "var(--accent)" }}
              >
                LIVE
              </span>
            </div>
            <p className="text-sm max-w-lg" style={{ color: "var(--text-muted)" }}>
              The agentic financial economy on Arc Testnet.
              Hire AI agents that deliver real data, paid with <strong style={{ color: "var(--accent)" }}>$TRID</strong> via Circle x402.
            </p>
          </div>

          {/* Wallet + balance */}
          {isConnected ? (
            <div
              className="rounded-2xl p-4 shrink-0 min-w-52"
              style={{
                background: "rgba(0,180,216,0.09)",
                border:     "1px solid rgba(0,180,216,0.2)",
              }}
            >
              <div className="text-xs font-semibold mb-3" style={{ color: "var(--text-muted)" }}>
                Your Wallet
              </div>
              <div className="space-y-1.5">
                <div className="flex justify-between text-xs">
                  <span style={{ color: "var(--text-muted)" }}>$TRID</span>
                  <span className="mono font-bold" style={{ color: "var(--accent)" }}>
                    {balance.loading ? "…" : parseFloat(balance.trid).toFixed(4)}
                  </span>
                </div>
                <div className="flex justify-between text-xs">
                  <span style={{ color: "var(--text-muted)" }}>Arc Gas</span>
                  <span className="mono font-bold" style={{ color: "var(--text-secondary)" }}>
                    {balance.loading ? "…" : balance.native}
                  </span>
                </div>
              </div>
              <div
                className="mt-3 pt-3 text-xs mono truncate"
                style={{ borderTop: "1px solid rgba(0,180,216,0.15)", color: "var(--text-muted)" }}
              >
                {address?.slice(0, 8)}…{address?.slice(-6)}
              </div>
              <button
                onClick={() => {
                  setShowUpload(true);
                }}
                className="btn-secondary w-full mt-3 text-xs py-1.5"
              >
                + Offer a Service
              </button>
            </div>
          ) : (
            <div className="shrink-0">
              <div className="text-sm mb-3" style={{ color: "var(--text-muted)" }}>
                Connect to hire agents & earn $TRID
              </div>
              <ConnectButton />
            </div>
          )}
        </div>
      </div>

      {/* ── Registered Agents Row ── */}
      {agents.length > 0 && (
        <div>
          <h2 className="text-sm font-semibold mb-3" style={{ color: "var(--text-muted)" }}>
            🤖 Active Agents ({agents.length})
          </h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {agents.slice(0, 6).map(ag => (
              <AgentChip key={ag.id} ag={ag} />
            ))}
          </div>
        </div>
      )}

      {/* ── Service Marketplace ── */}
      <div>
        {/* Toolbar */}
        <div className="flex items-center justify-between mb-5">
          <div>
            <h2 className="font-bold text-lg" style={{ color: "var(--text-primary)" }}>
              🔥 Trending Services
            </h2>
            <p className="text-xs mt-0.5" style={{ color: "var(--text-muted)" }}>
              Most-called agents first — click Hire to call the agent and see live data
            </p>
          </div>
          <input
            className="input w-44 text-sm"
            placeholder="Search…"
            value={filter}
            onChange={e => setFilter(e.target.value)}
          />
        </div>

        {loading ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {[...Array(6)].map((_, i) => (
              <div key={i} className="agent-card h-52 animate-pulse" style={{ background: "rgba(0,180,216,0.06)" }} />
            ))}
          </div>
        ) : trendingFirst.length === 0 ? (
          <div className="text-center py-16" style={{ color: "var(--text-muted)" }}>
            No agents found matching "{filter}"
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {trendingFirst.map(svc => (
              <AgentServiceCard
                key={svc.id}
                svc={svc}
                onResult={(name, result, price) =>
                  setServiceResult({ name, result, price })
                }
              />
            ))}
          </div>
        )}
      </div>

      {/* ── x402 explainer ── */}
      <div
        className="rounded-2xl p-6"
        style={{
          background: "rgba(0,180,216,0.05)",
          border:     "1px solid rgba(0,180,216,0.15)",
        }}
      >
        <h3 className="font-semibold text-sm mb-3" style={{ color: "var(--text-primary)" }}>
          How payments work
        </h3>
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
          {[
            ["1", "Connect wallet to Arc Testnet"],
            ["2", "Claim free $TRID from faucet"],
            ["3", 'Hit "Hire" — agent returns live data'],
            ["4", "Payment settled via Circle Gateway x402"],
            ["5", "Retrobot watches every transaction"],
          ].map(([n, text]) => (
            <div key={n} className="flex flex-col gap-1.5">
              <div
                className="w-7 h-7 rounded-lg flex items-center justify-center text-xs font-bold shrink-0"
                style={{ background: "rgba(0,180,216,0.15)", color: "var(--accent)" }}
              >
                {n}
              </div>
              <p className="text-xs" style={{ color: "var(--text-muted)" }}>{text}</p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── Demo fallback ─────────────────────────────────────────────────
const DEMO_SERVICES: Service[] = [
  { id: 1, name: "Price Feed",     service_type: "price_feed",       description: "Live crypto prices via CoinGecko — BTC, ETH, ARC, and 200+ assets",           price_per_call: 1000,  price_trid_display: "0.0010 TRID", endpoint: "/data/price-feed",      x402_enabled: true, calls_served: 3142, seller_reputation: 8500, seller_name: "Trident Protocol",  seller_address: "" },
  { id: 2, name: "FX Rates",       service_type: "fx_rates",         description: "Real-time forex including emerging markets — NGN, BRL, GHS, KES",              price_per_call: 1000,  price_trid_display: "0.0010 TRID", endpoint: "/data/fx-rates",        x402_enabled: true, calls_served: 2891, seller_reputation: 8500, seller_name: "Trident Protocol",  seller_address: "" },
  { id: 3, name: "Risk Score",     service_type: "risk_score",       description: "Wallet & asset risk scoring using on-chain analytics and heuristics",           price_per_call: 5000,  price_trid_display: "0.0050 TRID", endpoint: "/data/risk-score",      x402_enabled: true, calls_served: 1043, seller_reputation: 8500, seller_name: "Trident Protocol",  seller_address: "" },
  { id: 4, name: "AI Research",    service_type: "research_summary", description: "Claude-powered research briefs — any asset, any timeframe, instant delivery",  price_per_call: 10000, price_trid_display: "0.0100 TRID", endpoint: "/data/research-summary",x402_enabled: true, calls_served: 567,  seller_reputation: 8500, seller_name: "Trident Protocol",  seller_address: "" },
  { id: 5, name: "Portfolio Score",service_type: "compute_score",   description: "Quantitative scoring: Sharpe ratio, VaR, max drawdown, rebalance signal",      price_per_call: 20000, price_trid_display: "0.0200 TRID", endpoint: "/data/compute-score",   x402_enabled: true, calls_served: 289,  seller_reputation: 8500, seller_name: "Trident Protocol",  seller_address: "" },
  { id: 6, name: "Retrobot Audit", service_type: "retrobot_audit",  description: "Full payment history audit by Retrobot — any agent can hire Retrobot to audit", price_per_call: 5000,  price_trid_display: "0.0050 TRID", endpoint: "/retrobot/audit",       x402_enabled: true, calls_served: 194,  seller_reputation: 9200, seller_name: "Retrobot v1.0",     seller_address: "" },
];
