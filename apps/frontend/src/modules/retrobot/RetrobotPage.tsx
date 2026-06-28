import { useState, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import axios from "axios";

const API = import.meta.env.VITE_API_URL || "http://localhost:8000";

interface Anomaly {
  id: number;
  buyer: string;
  seller: string;
  amount: number;
  service_type: string;
  anomaly_type: string;
  reason: string;
  status: string;
  recovery_amount: number | null;
  created_at: string;
}

interface Stats {
  total_payments_scanned: number;
  total_anomalies_flagged: number;
  total_trid_recovered: number;
  detection_rate: number;
}

const ANOMALY_ICONS: Record<string, string> = {
  overpayment: "💸", duplicate: "🔁", failed_delivery: "⏱️", none: "✅",
};

const STATUS_COLORS: Record<string, string> = {
  disputed: "badge-red", recovered: "badge-green", pending: "badge-yellow", completed: "badge-green",
};

function AnomalyCard({ anomaly }: { anomaly: Anomaly }) {
  const [recovering, setRecovering] = useState(false);
  const [recovered, setRecovered] = useState(anomaly.status === "recovered");

  const handleRecover = async () => {
    setRecovering(true);
    try {
      await axios.post(`${API}/api/retrobot/recover`, {
        payment_id: anomaly.id,
        requester_address: anomaly.buyer,
      });
      setRecovered(true);
    } catch {
      alert("Recovery failed — check backend connection");
    } finally {
      setRecovering(false);
    }
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      className="card border-l-4 border-l-red-500/60"
    >
      <div className="flex items-start justify-between mb-2">
        <div className="flex items-center gap-2">
          <span className="text-xl">{ANOMALY_ICONS[anomaly.anomaly_type] || "⚠️"}</span>
          <div>
            <span className="font-medium text-white text-sm capitalize">
              {anomaly.anomaly_type.replace("_", " ")}
            </span>
            <p className="text-gray-500 text-xs">{anomaly.service_type}</p>
          </div>
        </div>
        <span className={`badge ${STATUS_COLORS[anomaly.status] || "badge-yellow"}`}>{anomaly.status}</span>
      </div>

      <p className="text-gray-400 text-xs mb-3 bg-gray-800/50 rounded p-2">{anomaly.reason}</p>

      <div className="grid grid-cols-2 gap-2 text-xs text-gray-500 mb-3">
        <div>
          <p className="text-gray-600 mb-0.5">Buyer</p>
          <p className="mono text-gray-300">{anomaly.buyer.slice(0, 8)}...{anomaly.buyer.slice(-4)}</p>
        </div>
        <div>
          <p className="text-gray-600 mb-0.5">Amount</p>
          <p className="mono text-violet-400">{(anomaly.amount / 1e6).toFixed(4)} TRID</p>
        </div>
      </div>

      {anomaly.status === "disputed" && !recovered && (
        <button
          onClick={handleRecover}
          disabled={recovering}
          className="btn-primary w-full text-xs py-1.5"
        >
          {recovering ? "Recovering..." : "⚡ Initiate Recovery"}
        </button>
      )}
      {(recovered || anomaly.status === "recovered") && (
        <div className="badge badge-green w-full justify-center py-1.5">
          ✅ Recovered — {(( anomaly.recovery_amount || anomaly.amount) / 1e6).toFixed(4)} TRID
        </div>
      )}
    </motion.div>
  );
}

export default function RetrobotPage() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [anomalies, setAnomalies] = useState<Anomaly[]>([]);
  const [walletFilter, setWalletFilter] = useState("");
  const [scanning, setScanning] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const load = async () => {
      try {
        const [statsRes, anomalyRes] = await Promise.all([
          axios.get(`${API}/api/retrobot/stats`),
          axios.get(`${API}/api/retrobot/anomalies`),
        ]);
        setStats(statsRes.data);
        setAnomalies(anomalyRes.data.anomalies || []);
      } catch {
        setStats(DEMO_STATS);
        setAnomalies(DEMO_ANOMALIES);
      } finally {
        setLoading(false);
      }
    };
    load();
    const interval = setInterval(load, 15_000);
    return () => clearInterval(interval);
  }, []);

  const handleFilter = async () => {
    if (!walletFilter) return;
    setScanning(true);
    try {
      const res = await axios.get(`${API}/api/retrobot/anomalies`, {
        params: { wallet_address: walletFilter },
      });
      setAnomalies(res.data.anomalies || []);
    } catch {
      alert("Filter failed — backend not running");
    } finally {
      setScanning(false);
    }
  };

  return (
    <div>
      <div className="mb-8">
        <div className="flex items-center gap-3 mb-2">
          <span className="text-3xl">🤖</span>
          <h1 className="text-3xl font-bold text-white">Retrobot</h1>
          <span className="badge badge-green">Active</span>
        </div>
        <p className="text-gray-400">
          Autonomous payment recovery agent. Detects overpayments, duplicates, and failed deliveries.
          Every transaction is covered — not just routed.
        </p>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-8">
        {[
          { label: "Payments Scanned", value: stats?.total_payments_scanned ?? "—", icon: "🔍" },
          { label: "Anomalies Flagged", value: stats?.total_anomalies_flagged ?? "—", icon: "⚠️" },
          { label: "TRID Recovered", value: stats ? `${(stats.total_trid_recovered / 1e6).toFixed(2)}` : "—", icon: "💰" },
          { label: "Detection Rate", value: stats ? `${stats.detection_rate}%` : "—", icon: "🎯" },
        ].map(s => (
          <div key={s.label} className="stat-box">
            <span className="text-2xl">{s.icon}</span>
            <span className="text-xl font-bold text-white">{s.value}</span>
            <span className="text-gray-500 text-xs">{s.label}</span>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2">
          <div className="flex items-center justify-between mb-4">
            <h2 className="font-semibold text-white">
              Anomaly Dashboard
              <span className="ml-2 badge badge-red">{anomalies.length}</span>
            </h2>
            <div className="flex gap-2">
              <input
                className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-sm text-gray-300 placeholder-gray-600 focus:outline-none focus:border-violet-500 w-40"
                placeholder="0x wallet..."
                value={walletFilter}
                onChange={e => setWalletFilter(e.target.value)}
              />
              <button onClick={handleFilter} disabled={scanning} className="btn-secondary text-xs py-1.5 px-3">
                {scanning ? "..." : "Filter"}
              </button>
            </div>
          </div>

          {loading ? (
            <div className="space-y-4">
              {[...Array(3)].map((_, i) => <div key={i} className="card animate-pulse h-40 bg-gray-900" />)}
            </div>
          ) : (
            <AnimatePresence>
              {anomalies.length === 0 ? (
                <motion.div
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  className="card text-center py-12"
                >
                  <p className="text-5xl mb-3">✅</p>
                  <p className="text-gray-400">No anomalies detected. All clear.</p>
                </motion.div>
              ) : (
                <div className="space-y-4">
                  {anomalies.map(a => <AnomalyCard key={a.id} anomaly={a} />)}
                </div>
              )}
            </AnimatePresence>
          )}
        </div>

        <div className="space-y-4">
          <div className="card">
            <h3 className="font-semibold text-white mb-4">Detection Rules</h3>
            <div className="space-y-3">
              {[
                { icon: "💸", label: "Overpayment", desc: "Flags payments >110% of market rate" },
                { icon: "🔁", label: "Duplicate", desc: "Same tx within 5-minute window" },
                { icon: "⏱️", label: "Failed Delivery", desc: "Job timeout exceeded" },
                { icon: "🧠", label: "Claude Reasoning", desc: "AI adjudicates ambiguous cases" },
              ].map(r => (
                <div key={r.label} className="flex gap-3 text-xs">
                  <span className="text-xl w-6 shrink-0">{r.icon}</span>
                  <div>
                    <p className="font-medium text-gray-300">{r.label}</p>
                    <p className="text-gray-500">{r.desc}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="card">
            <h3 className="font-semibold text-white mb-3">Hire Retrobot</h3>
            <p className="text-gray-400 text-xs mb-3">
              Any agent on Arc can pay to audit their own payment history.
              Priced in TRID via x402.
            </p>
            <div className="space-y-1.5 text-xs">
              <div className="flex justify-between"><span className="text-gray-500">Audit (24h)</span><span className="mono text-violet-400">0.005 TRID</span></div>
              <div className="flex justify-between"><span className="text-gray-500">Single scan</span><span className="mono text-violet-400">0.001 TRID</span></div>
              <div className="flex justify-between"><span className="text-gray-500">Recovery</span><span className="mono text-violet-400">0.010 TRID</span></div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

const DEMO_STATS: Stats = {
  total_payments_scanned: 1847, total_anomalies_flagged: 23,
  total_trid_recovered: 450000, detection_rate: 98.7,
};

const DEMO_ANOMALIES: Anomaly[] = [
  { id: 1, buyer: "0xaBcD1234abcd1234abcd1234abcd1234abcd1234", seller: "0x9999aaaabbbb1111cccc2222dddd3333eeee4444", amount: 15000, service_type: "price_feed", anomaly_type: "overpayment", reason: "Payment is 50% above average price for price_feed", status: "disputed", recovery_amount: null, created_at: new Date().toISOString() },
  { id: 2, buyer: "0xDEAD1234dead1234dead1234dead1234dead1234", seller: "0xBEEF5678beef5678beef5678beef5678beef5678", amount: 5000, service_type: "fx_rates", anomaly_type: "duplicate", reason: "Identical payment made within 5 minutes", status: "recovered", recovery_amount: 5000, created_at: new Date(Date.now() - 300000).toISOString() },
];
