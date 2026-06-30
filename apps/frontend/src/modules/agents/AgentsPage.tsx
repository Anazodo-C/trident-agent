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
// NODE_API removed — direct Python backend calls used for hire

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

// ── Static demo results (no backend needed) ──────────────────────
const DEMO_RESULTS: Record<string, unknown> = {
  price_feed: {
    service: "price_feed", provider: "Trident / CoinGecko (demo)",
    data: { BTC: { usd: 67420.12, change_24h: 2.3 }, ETH: { usd: 3541.88, change_24h: 1.8 }, USDC: { usd: 1.0001, change_24h: 0.01 }, SOL: { usd: 178.42, change_24h: 4.2 } },
    price_paid: "0.001 TRID", note: "demo — start backend for live prices",
  },
  fx_rates: {
    service: "fx_rates", provider: "Trident / Alpha Vantage (demo)",
    data: { EUR: 0.9214, GBP: 0.7891, NGN: 1602.5, JPY: 149.72, BRL: 5.071, GHS: 15.64 },
    price_paid: "0.001 TRID", note: "demo — start backend for live rates",
  },
  risk_score: {
    service: "risk_score", provider: "Trident / Messari (demo)",
    data: { risk_score: 72, label: "Medium", factors: ["active 6 months", "3 DeFi protocols", "no sanctions hits"] },
    price_paid: "0.005 TRID", note: "demo — start backend for live scoring",
  },
  research_summary: {
    service: "research_summary", provider: "Trident / Claude (demo)",
    asset: "BTC",
    data: { summary: "Bitcoin continues to consolidate above key support at $65k. ETF inflows remain strong. Halving supply dynamics are expected to drive bullish momentum into Q3 2026.", sentiment: "bullish", confidence: 0.74 },
    price_paid: "0.01 TRID", note: "demo — start backend for Claude-powered research",
  },
  compute_score: {
    service: "compute_score", provider: "Trident (demo)",
    data: { sharpe_ratio: 1.84, var_95: -0.062, max_drawdown: -0.18, rebalance_signal: "hold", score: 78 },
    price_paid: "0.02 TRID", note: "demo — start backend for live portfolio scoring",
  },
  retrobot_audit: {
    service: "retrobot_audit",
    data: { total_scanned: 312, anomalies_caught: 38, total_recovered: "1.24 TRID", detection_rate: "12.2%", status: "guardian_active" },
    price_paid: "0.005 TRID", note: "demo — start backend for live Retrobot audit",
  },
};

// ── Hire Card ────────────────────────────────────────────────────
function AgentServiceCard({
  svc,
  onResult,
  backendLive,
}: {
  svc: Service;
  onResult: (name: string, result: unknown, price: string) => void;
  backendLive: boolean;
}) {
  const { address, isConnected } = useAccount();
  const { show, dismiss }        = useToastHook();
  const [busy, setBusy]          = useState(false);

  /** Build the correct Python backend URL + query params for each service type */
  const buildCallUrl = (): string => {
    const base = API;
    // The Python backend mounts marketplace routes at /api/marketplace
    // Stored endpoint is e.g. "/data/price-feed" → full: /api/marketplace/data/price-feed
    switch (svc.service_type) {
      case "price_feed":
        return `${base}/api/marketplace/data/price-feed?symbols=BTC,ETH,USDC,SOL`;
      case "fx_rates":
        return `${base}/api/marketplace/data/fx-rates?base=USD&targets=EUR,GBP,NGN,JPY,BRL,GHS`;
      case "risk_score":
        return `${base}/api/marketplace/data/risk-score?address=${address || "0x0000000000000000000000000000000000000001"}`;
      case "research_summary":
        return `${base}/api/marketplace/data/research-summary?asset=BTC`;
      case "compute_score":
        return `${base}/api/marketplace/data/compute-score?portfolio=BTC:0.4,ETH:0.3,SOL:0.2,USDC:0.1&model=sharpe`;
      case "retrobot_audit":
        return `${base}/api/retrobot/stats`;
      default:
        // Fallback: try /api/marketplace + stored endpoint
        return `${base}/api/marketplace${svc.endpoint}`;
    }
  };

  const handleHire = async () => {
    if (!isConnected) {
      show("Connect your wallet to hire agents", "error");
      return;
    }
    setBusy(true);
    const tid = show(`Hiring ${svc.name}…`, "loading");

    // If backend is known to be offline, return demo result immediately
    if (!backendLive) {
      await new Promise(r => setTimeout(r, 900)); // simulate latency
      dismiss(tid);
      show(`${svc.name} responded (demo mode)`, "info", 2500);
      onResult(svc.name, DEMO_RESULTS[svc.service_type] ?? { demo: true }, svc.price_trid_display);
      setBusy(false);
      return;
    }

    try {
      const url = buildCallUrl();
      const r = await axios.get(url, { timeout: 12000 });
      dismiss(tid);
      onResult(svc.name, r.data, svc.price_trid_display);
    } catch (err: any) {
      dismiss(tid);
      // Backend went offline mid-session — fall back to demo
      const status = err?.response?.status;
      if (!status) {
        show(`${svc.name} responded (demo mode — backend offline)`, "info", 2500);
        onResult(svc.name, DEMO_RESULTS[svc.service_type] ?? { demo: true }, svc.price_trid_display);
      } else {
        const msg =
          status === 402 ? "x402 payment required — this endpoint is paywalled" :
          status === 404 ? "Endpoint not found — check backend logs" :
          (err?.response?.data?.detail as string) || err.message || "Service call failed";
        show(msg, "error", 5000);
      }
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
  const [agents,      setAgents]      = useState<Agent[]>([]);
  const [services,    setServices]    = useState<Service[]>([]);
  const [filter,      setFilter]      = useState("");
  const [loading,     setLoading]     = useState(true);
  const [backendLive, setBackendLive] = useState(true);

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

  // Load data — use allSettled so one failure doesn't kill everything
  useEffect(() => {
    const load = async () => {
      const [agRes, svcRes] = await Promise.allSettled([
        axios.get(`${API}/api/agents/`),
        axios.get(`${API}/api/marketplace/services`),
      ]);

      const agOk  = agRes.status  === "fulfilled";
      const svcOk = svcRes.status === "fulfilled";

      if (!agOk && !svcOk) {
        // Both failed — backend truly offline
        setBackendLive(false);
        setServices(DEMO_SERVICES);
        setAgents(DEMO_AGENTS);
      } else {
        setBackendLive(true);
        if (agOk) {
          // Normalise backend field names: wallet_address → wallet, agent_id → id
          const raw = (agRes as PromiseFulfilledResult<any>).value.data.agents || [];
          setAgents(raw.map((a: any) => ({
            id:               a.id ?? a.agent_id ?? 0,
            name:             a.name ?? "Unknown",
            agent_type:       a.agent_type ?? "seller",
            wallet:           a.wallet ?? a.wallet_address ?? "",
            reputation_score: a.reputation_score ?? 5000,
            arc_agent_id:     a.arc_agent_id,
            registered_at:    a.registered_at,
          })));
        }
        if (svcOk) {
          const svcs = (svcRes as PromiseFulfilledResult<any>).value.data.services;
          setServices(svcs?.length ? svcs : DEMO_SERVICES);
        } else {
          setServices(DEMO_SERVICES);
        }
      }
      setLoading(false);
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
            axios.get(`${API}/api/agents/`).then(r => setAgents(r.data.agents || [])).catch(() => {});
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

      {/* ── Backend offline banner ── */}
      {!backendLive && (
        <div
          className="rounded-xl px-4 py-3 flex items-center gap-3 text-sm"
          style={{ background: "rgba(245,158,11,0.1)", border: "1px solid rgba(245,158,11,0.3)" }}
        >
          <span className="text-lg">⚡</span>
          <div>
            <span className="font-semibold" style={{ color: "#f59e0b" }}>Demo mode</span>
            <span className="ml-2" style={{ color: "var(--text-muted)" }}>
              — backend offline. Start it with{" "}
              <code
                className="mono px-1.5 py-0.5 rounded text-xs"
                style={{ background: "rgba(245,158,11,0.15)" }}
              >
                docker compose up
              </code>
              {" "}from the project root to enable live data + hiring.
            </span>
          </div>
        </div>
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
                backendLive={backendLive}
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

// ── Demo data (shown when backend is offline) ─────────────────────
const DEMO_AGENTS: Agent[] = [
  { id: 1, name: "Retrobot v1.0",    agent_type: "retrobot", wallet: "0x3315ebaab06d6266e92f6063b9360ae10d24F0a0", reputation_score: 9200, arc_agent_id: 1 },
  { id: 2, name: "Alpha Buyer",      agent_type: "buyer",    wallet: "0xabc4000000000000000000000000000000000001", reputation_score: 7400 },
  { id: 3, name: "Beta Buyer",       agent_type: "buyer",    wallet: "0xabc5000000000000000000000000000000000002", reputation_score: 6800 },
  { id: 4, name: "Gamma Seller",     agent_type: "seller",   wallet: "0xabc1000000000000000000000000000000000003", reputation_score: 8100, arc_agent_id: 2 },
];

const DEMO_SERVICES: Service[] = [
  { id: 1, name: "Price Feed",     service_type: "price_feed",       description: "Live crypto prices via CoinGecko — BTC, ETH, ARC, and 200+ assets",           price_per_call: 1000,  price_trid_display: "0.0010 TRID", endpoint: "/data/price-feed",      x402_enabled: true, calls_served: 3142, seller_reputation: 8500, seller_name: "Trident Protocol",  seller_address: "" },
  { id: 2, name: "FX Rates",       service_type: "fx_rates",         description: "Real-time forex including emerging markets — NGN, BRL, GHS, KES",              price_per_call: 1000,  price_trid_display: "0.0010 TRID", endpoint: "/data/fx-rates",        x402_enabled: true, calls_served: 2891, seller_reputation: 8500, seller_name: "Trident Protocol",  seller_address: "" },
  { id: 3, name: "Risk Score",     service_type: "risk_score",       description: "Wallet & asset risk scoring using on-chain analytics and heuristics",           price_per_call: 5000,  price_trid_display: "0.0050 TRID", endpoint: "/data/risk-score",      x402_enabled: true, calls_served: 1043, seller_reputation: 8500, seller_name: "Trident Protocol",  seller_address: "" },
  { id: 4, name: "AI Research",    service_type: "research_summary", description: "Claude-powered research briefs — any asset, any timeframe, instant delivery",  price_per_call: 10000, price_trid_display: "0.0100 TRID", endpoint: "/data/research-summary",x402_enabled: true, calls_served: 567,  seller_reputation: 8500, seller_name: "Trident Protocol",  seller_address: "" },
  { id: 5, name: "Portfolio Score",service_type: "compute_score",   description: "Quantitative scoring: Sharpe ratio, VaR, max drawdown, rebalance signal",      price_per_call: 20000, price_trid_display: "0.0200 TRID", endpoint: "/data/compute-score",   x402_enabled: true, calls_served: 289,  seller_reputation: 8500, seller_name: "Trident Protocol",  seller_address: "" },
  { id: 6, name: "Retrobot Audit", service_type: "retrobot_audit",  description: "Full payment history audit by Retrobot — any agent can hire Retrobot to audit", price_per_call: 5000,  price_trid_display: "0.0050 TRID", endpoint: "/retrobot/audit",       x402_enabled: true, calls_served: 194,  seller_reputation: 9200, seller_name: "Retrobot v1.0",     seller_address: "" },
];
