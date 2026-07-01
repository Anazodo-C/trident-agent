import { useState, useEffect, useRef } from "react";
import { useAccount, useWriteContract, useWaitForTransactionReceipt } from "wagmi";
import { ConnectButton } from "@rainbow-me/rainbowkit";
import axios from "axios";

// TRID ERC-20 — transfer ABI (minimal)
const TRID_ABI = [
  {
    name: "transfer",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to",    type: "address" },
      { name: "value", type: "uint256" },
    ],
    outputs: [{ type: "bool" }],
  },
] as const;

const TRID_ADDRESS = (import.meta.env.VITE_TRIDENT_TOKEN_ADDRESS ||
  "0x5fc8e8b3DC37Bcbb7bC7F013F6a8C56375B40dF7") as `0x${string}`;

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
  trid_balance?: number;   // micro-units (6 dec) — buyer agents only
  total_spent?:  number;   // micro-units
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
  const [portfolioInput, setPortfolioInput] = useState("BTC:0.4,ETH:0.3,SOL:0.2,USDC:0.1");
  const [pendingTxHash, setPendingTxHash]   = useState<`0x${string}` | undefined>();

  const { writeContractAsync } = useWriteContract();
  // track receipt so wagmi caches the tx; result used in ServiceResultModal via pendingTxHash
  useWaitForTransactionReceipt({ hash: pendingTxHash });

  /** Build params for POST /hire based on service type */
  const buildHireParams = (): Record<string, string> => {
    switch (svc.service_type) {
      case "price_feed":
        return { symbols: "BTC,ETH,USDC,SOL" };
      case "fx_rates":
        return { base: "USD", targets: "EUR,GBP,NGN,JPY,BRL,GHS" };
      case "risk_score":
        return { address: address || "0x0000000000000000000000000000000000000001" };
      case "compute_score":
        return { portfolio: portfolioInput.trim() || "BTC:0.5,ETH:0.5", model: "sharpe" };
      case "retrobot_audit":
        return { buyer_address: address || "0x0000000000000000000000000000000000000001" };
      default:
        return {};
    }
  };

  const handleHire = async () => {
    if (!isConnected) {
      show("Connect your wallet to hire agents", "error");
      return;
    }
    setBusy(true);
    const tid = show(`Sending x402 payment for ${svc.name}…`, "loading");

    // Demo fallback if backend is offline
    if (!backendLive) {
      await new Promise(r => setTimeout(r, 900));
      dismiss(tid);
      show(`${svc.name} responded (demo mode)`, "info", 2500);
      onResult(svc.name, DEMO_RESULTS[svc.service_type] ?? { demo: true }, svc.price_trid_display);
      setBusy(false);
      return;
    }

    try {
      // ── Step 1: TRID on-chain transfer (verifiable on ArcScan) ──
      const sellerAddr = (svc.seller_address || "0x3315ebaab06d6266e92f6063b9360ae10d24F0a0") as `0x${string}`;
      const tridAmount = BigInt(svc.price_per_call); // already in micro-units (6 decimals)

      let txHash: `0x${string}` | undefined;
      try {
        dismiss(tid);
        const tid2 = show(`Sign TRID payment in your wallet…`, "loading");
        txHash = await writeContractAsync({
          address:      TRID_ADDRESS,
          abi:          TRID_ABI,
          functionName: "transfer",
          args:         [sellerAddr, tridAmount],
        });
        setPendingTxHash(txHash);
        dismiss(tid2);
        show(`⛓ TRID tx submitted — fetching data…`, "info", 4000);
      } catch (txErr: any) {
        // User rejected or insufficient TRID — still fetch data but note it
        const rejected = txErr?.message?.includes("rejected") || txErr?.code === 4001;
        if (rejected) {
          dismiss(tid);
          show("Transaction rejected — hire cancelled", "error", 4000);
          setBusy(false);
          return;
        }
        show(`TRID tx failed (${txErr?.shortMessage || "insufficient balance?"}) — fetching data anyway`, "info", 4000);
      }

      // ── Step 2: Fetch data via x402 (Circle Gateway nanopayment) ──
      const r = await axios.post(
        `${NODE_API}/hire`,
        {
          service_type: svc.service_type,
          params: buildHireParams(),
          buyer_address: address,
        },
        { timeout: 20000 }
      );

      dismiss(tid);
      const payload = r.data;

      // Annotate result with both payment proofs
      const resultData = {
        ...(payload.data ?? payload),
        _x402: {
          amount_paid: payload.amount_paid,
          transaction: payload.transaction,
          paid_by:     payload.paid_by,
        },
        _trid: txHash ? {
          tx_hash:  txHash,
          amount:   svc.price_trid_display,
          arcscan:  `https://explorer.testnet.arc.network/tx/${txHash}`,
        } : undefined,
      };

      const priceDisplay = `${svc.price_trid_display} TRID${payload.amount_paid ? ` + ${payload.amount_paid} USDC` : ""}`;
      onResult(svc.name, resultData, priceDisplay);

      if (txHash) {
        show(`✅ Paid ${svc.price_trid_display} TRID on-chain + x402 data fee`, "success", 5000);
      } else if (payload.x402) {
        show(`✅ Paid ${payload.amount_paid} USDC via Circle Gateway x402`, "success", 4000);
      }
    } catch (err: any) {
      dismiss(tid);
      const status = err?.response?.status;
      const data   = err?.response?.data;

      if (!status) {
        // Node backend offline → try Python backend directly (no x402)
        try {
          const base = API;
          let url = "";
          switch (svc.service_type) {
            case "price_feed":     url = `${base}/api/marketplace/data/price-feed?symbols=BTC,ETH,USDC,SOL`; break;
            case "fx_rates":       url = `${base}/api/marketplace/data/fx-rates?base=USD&targets=EUR,GBP,NGN,JPY,BRL,GHS`; break;
            case "risk_score":     url = `${base}/api/marketplace/data/risk-score?address=${address || "0x1"}`; break;
            case "compute_score":  url = `${base}/api/marketplace/data/compute-score?portfolio=${encodeURIComponent(portfolioInput || "BTC:0.5,ETH:0.5")}&model=sharpe`; break;
            case "retrobot_audit": url = `${base}/api/retrobot/stats`; break;
            default:               url = `${base}/api/marketplace${svc.endpoint}`;
          }
          const fallback = await axios.get(url, { timeout: 10000 });
          show(`${svc.name} responded (no x402 — node backend offline)`, "info", 3000);
          onResult(svc.name, fallback.data, svc.price_trid_display);
        } catch {
          show(`${svc.name} responded (demo mode — backends offline)`, "info", 2500);
          onResult(svc.name, DEMO_RESULTS[svc.service_type] ?? { demo: true }, svc.price_trid_display);
        }
      } else if (status === 402) {
        const msg = data?.message || "x402: fund the buyer agent wallet at faucet.circle.com";
        show(`Payment required — ${msg}`, "error", 7000);
      } else {
        const msg = data?.error || data?.message || data?.detail || err.message || "Service call failed";
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

      {/* Per-service input fields */}
      {svc.service_type === "compute_score" && (
        <div className="mb-3">
          <label className="text-xs mb-1 block" style={{ color: "var(--text-muted)" }}>
            Portfolio <span className="opacity-60">(ASSET:weight, …)</span>
          </label>
          <input
            className="input text-xs py-1.5"
            placeholder="BTC:0.4,ETH:0.3,SOL:0.2,USDC:0.1"
            value={portfolioInput}
            onChange={e => setPortfolioInput(e.target.value)}
            onKeyDown={e => e.key === "Enter" && !busy && handleHire()}
          />
        </div>
      )}

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
          {busy ? "⏳ Paying…" : "Hire → x402"}
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
      <div className="min-w-0 flex-1">
        <div className="text-xs font-semibold truncate" style={{ color: "var(--text-primary)" }}>
          {ag.name}
        </div>
        <div className="text-xs truncate" style={{ color: "var(--text-muted)" }}>
          {ag.wallet.slice(0, 6)}…{ag.wallet.slice(-4)}
          {ag.arc_agent_id ? ` · Arc #${ag.arc_agent_id}` : ""}
        </div>
        {ag.agent_type === "buyer" && ag.trid_balance !== undefined && (
          <div className="text-xs mt-0.5 font-mono" style={{ color: "var(--accent)", opacity: 0.85 }}>
            {(ag.trid_balance / 1_000_000).toLocaleString(undefined, { maximumFractionDigits: 4 })} TRID
            {ag.total_spent ? (
              <span style={{ color: "var(--text-muted)", fontWeight: 400 }}>
                {" "}· {(ag.total_spent / 1_000_000).toFixed(4)} spent
              </span>
            ) : null}
          </div>
        )}
      </div>
      <div className="ml-auto shrink-0">
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
            trid_balance:     a.trid_balance,
            total_spent:      a.total_spent,
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
  { id: 2, name: "AlphaBot",         agent_type: "seller",   wallet: "0xabc1000000000000000000000000000000000001", reputation_score: 8500, arc_agent_id: 2 },
  { id: 3, name: "DataMaven",        agent_type: "seller",   wallet: "0xabc2000000000000000000000000000000000002", reputation_score: 8100, arc_agent_id: 3 },
  { id: 4, name: "Alpha Buyer",      agent_type: "buyer",    wallet: "0xabc4000000000000000000000000000000000004", reputation_score: 7400, trid_balance: 100_000_000_000, total_spent: 0 },
  { id: 5, name: "Beta Buyer",       agent_type: "buyer",    wallet: "0xabc5000000000000000000000000000000000005", reputation_score: 6800, trid_balance: 100_000_000_000, total_spent: 0 },
  { id: 6, name: "Gamma Buyer",      agent_type: "buyer",    wallet: "0xabc6000000000000000000000000000000000006", reputation_score: 6300, trid_balance: 100_000_000_000, total_spent: 0 },
];

const DEMO_SERVICES: Service[] = [
  { id: 1, name: "Price Feed",     service_type: "price_feed",       description: "Live crypto prices via CoinGecko — BTC, ETH, ARC, and 200+ assets",           price_per_call: 1000,  price_trid_display: "0.0010 TRID", endpoint: "/data/price-feed",      x402_enabled: true, calls_served: 3142, seller_reputation: 8500, seller_name: "Trident Protocol",  seller_address: "" },
  { id: 2, name: "FX Rates",       service_type: "fx_rates",         description: "Real-time forex including emerging markets — NGN, BRL, GHS, KES",              price_per_call: 1000,  price_trid_display: "0.0010 TRID", endpoint: "/data/fx-rates",        x402_enabled: true, calls_served: 2891, seller_reputation: 8500, seller_name: "Trident Protocol",  seller_address: "" },
  { id: 3, name: "Risk Score",     service_type: "risk_score",       description: "Wallet & asset risk scoring using on-chain analytics and heuristics",           price_per_call: 5000,  price_trid_display: "0.0050 TRID", endpoint: "/data/risk-score",      x402_enabled: true, calls_served: 1043, seller_reputation: 8500, seller_name: "Trident Protocol",  seller_address: "" },
  { id: 5, name: "Portfolio Score",service_type: "compute_score",   description: "Quantitative scoring: Sharpe ratio, VaR, max drawdown, rebalance signal",      price_per_call: 20000, price_trid_display: "0.0200 TRID", endpoint: "/data/compute-score",   x402_enabled: true, calls_served: 289,  seller_reputation: 8500, seller_name: "Trident Protocol",  seller_address: "" },
  { id: 6, name: "Retrobot Audit", service_type: "retrobot_audit",  description: "Full payment history audit by Retrobot — any agent can hire Retrobot to audit", price_per_call: 5000,  price_trid_display: "0.0050 TRID", endpoint: "/retrobot/audit",       x402_enabled: true, calls_served: 194,  seller_reputation: 9200, seller_name: "Retrobot v1.0",     seller_address: "" },
];
