import { useState, useEffect } from "react";
import { motion } from "framer-motion";
import {
  LineChart, Line, BarChart, Bar, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer, Legend,
} from "recharts";
import axios from "axios";

const API = import.meta.env.VITE_API_URL || "http://localhost:8000";

interface Overview {
  total_volume_display: string;
  total_transactions: number;
  total_recovered_display: string;
  anomalies_caught: number;
  active_agents: number;
  active_services: number;
  volume_24h_display: string;
  transactions_24h: number;
  retrobot_recovery_rate: string;
}

interface VolumePoint {
  time: string;
  volume: number;
  transactions: number;
  recovered: number;
}

interface RetrobotStats {
  total_scanned: number;
  anomalies_caught: number;
  total_recovered_display: string;
  detection_rate: string;
  anomaly_breakdown: Record<string, number>;
  recent_anomalies: {
    id: number;
    buyer: string;
    seller: string;
    amount: string;
    type: string;
    reason: string;
    recovered: string | null;
    status: string;
    timestamp: string;
  }[];
}

const DEMO_VOLUME: VolumePoint[] = Array.from({ length: 12 }, (_, i) => ({
  time: `${i * 2}:00`,
  volume: Math.random() * 2 + 0.1,
  transactions: Math.floor(Math.random() * 8) + 1,
  recovered: Math.random() * 0.3,
}));

const ANOMALY_COLORS: Record<string, string> = {
  overpayment: "#f59e0b",
  duplicate: "#ef4444",
  failed_delivery: "#8b5cf6",
};

export default function DashboardPage() {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [volumeData, setVolumeData] = useState<VolumePoint[]>(DEMO_VOLUME);
  const [retrobot, setRetrobot] = useState<RetrobotStats | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchAll = async () => {
    try {
      const [ov, vol, rb] = await Promise.all([
        axios.get(`${API}/api/stats/overview`),
        axios.get(`${API}/api/stats/volume?hours=24`),
        axios.get(`${API}/api/stats/retrobot`),
      ]);
      setOverview(ov.data);
      if (vol.data.data?.length > 0) setVolumeData(vol.data.data);
      setRetrobot(rb.data);
    } catch {
      // keep demo data
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchAll();
    const interval = setInterval(fetchAll, 15000); // refresh every 15s
    return () => clearInterval(interval);
  }, []);

  const statCards = [
    {
      label: "Total Volume",
      value: overview?.total_volume_display ?? "—",
      sub: `${overview?.transactions_24h ?? 0} tx today`,
      color: "text-violet-400",
      bg: "bg-violet-500/10",
    },
    {
      label: "Retrobot Recovered",
      value: overview?.total_recovered_display ?? "—",
      sub: `${overview?.anomalies_caught ?? 0} anomalies caught`,
      color: "text-emerald-400",
      bg: "bg-emerald-500/10",
    },
    {
      label: "Active Agents",
      value: overview?.active_agents ?? "—",
      sub: `${overview?.active_services ?? 0} services live`,
      color: "text-blue-400",
      bg: "bg-blue-500/10",
    },
    {
      label: "Recovery Rate",
      value: overview?.retrobot_recovery_rate ?? "—",
      sub: "of flagged volume",
      color: "text-amber-400",
      bg: "bg-amber-500/10",
    },
  ];

  return (
    <div className="space-y-8">
      {/* Header */}
      <div>
        <h1 className="text-3xl font-bold text-white flex items-center gap-3">
          <span className="text-4xl">📊</span> Live Dashboard
        </h1>
        <p className="text-gray-400 mt-1">
          Autonomous agent activity — real-time volume, Retrobot recoveries, and anomaly detection.
        </p>
      </div>

      {/* Retrobot Hero Banner */}
      <motion.div
        initial={{ opacity: 0, y: -10 }}
        animate={{ opacity: 1, y: 0 }}
        className="bg-gradient-to-r from-violet-900/60 via-purple-900/60 to-indigo-900/60 border border-violet-500/30 rounded-2xl p-6"
      >
        <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <span className="text-2xl">🤖</span>
              <span className="text-violet-300 font-bold text-lg">Retrobot — Autonomous Payment Guardian</span>
              <span className="bg-emerald-500/20 text-emerald-400 text-xs px-2 py-0.5 rounded-full border border-emerald-500/30">
                LIVE
              </span>
            </div>
            <p className="text-gray-300 text-sm max-w-xl">
              Retrobot scans every agent transaction in real-time using LangChain + Claude. It autonomously detects
              overpayments, duplicates, and failed deliveries — then executes on-chain recovery via TridentEscrow.
            </p>
          </div>
          <div className="flex gap-6 text-center shrink-0">
            <div>
              <div className="text-2xl font-bold text-emerald-400">{retrobot?.total_recovered_display ?? "0 TRID"}</div>
              <div className="text-xs text-gray-500">Total Recovered</div>
            </div>
            <div>
              <div className="text-2xl font-bold text-amber-400">{retrobot?.detection_rate ?? "0%"}</div>
              <div className="text-xs text-gray-500">Detection Rate</div>
            </div>
            <div>
              <div className="text-2xl font-bold text-violet-400">{retrobot?.total_scanned ?? 0}</div>
              <div className="text-xs text-gray-500">Tx Scanned</div>
            </div>
          </div>
        </div>
      </motion.div>

      {/* Stat Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {statCards.map((card, i) => (
          <motion.div
            key={card.label}
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: i * 0.05 }}
            className={`${card.bg} border border-gray-800 rounded-xl p-4`}
          >
            <div className={`text-2xl font-bold ${card.color}`}>{card.value}</div>
            <div className="text-gray-300 text-sm font-medium mt-1">{card.label}</div>
            <div className="text-gray-500 text-xs mt-0.5">{card.sub}</div>
          </motion.div>
        ))}
      </div>

      {/* Volume Chart */}
      <div className="bg-gray-900/60 border border-gray-800 rounded-2xl p-6">
        <h2 className="text-white font-semibold mb-4 flex items-center gap-2">
          <span>📈</span> TRID Volume (24h)
        </h2>
        <ResponsiveContainer width="100%" height={260}>
          <LineChart data={volumeData}>
            <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" />
            <XAxis
              dataKey="time"
              tick={{ fill: "#6b7280", fontSize: 11 }}
              tickFormatter={(v) => v.slice(11, 16) || v}
            />
            <YAxis tick={{ fill: "#6b7280", fontSize: 11 }} />
            <Tooltip
              contentStyle={{ backgroundColor: "#111827", border: "1px solid #374151", borderRadius: 8 }}
              labelStyle={{ color: "#9ca3af" }}
            />
            <Legend />
            <Line type="monotone" dataKey="volume" stroke="#7c3aed" strokeWidth={2} dot={false} name="Volume (TRID)" />
            <Line type="monotone" dataKey="recovered" stroke="#10b981" strokeWidth={2} dot={false} name="Recovered (TRID)" />
          </LineChart>
        </ResponsiveContainer>
      </div>

      {/* Transaction Bar Chart + Anomaly Breakdown side by side */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="bg-gray-900/60 border border-gray-800 rounded-2xl p-6">
          <h2 className="text-white font-semibold mb-4">⚡ Transactions per Hour</h2>
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={volumeData}>
              <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" />
              <XAxis dataKey="time" tick={{ fill: "#6b7280", fontSize: 10 }} tickFormatter={(v) => v.slice(11, 16) || v} />
              <YAxis tick={{ fill: "#6b7280", fontSize: 10 }} />
              <Tooltip contentStyle={{ backgroundColor: "#111827", border: "1px solid #374151", borderRadius: 8 }} />
              <Bar dataKey="transactions" fill="#7c3aed" radius={[4, 4, 0, 0]} name="Transactions" />
            </BarChart>
          </ResponsiveContainer>
        </div>

        <div className="bg-gray-900/60 border border-gray-800 rounded-2xl p-6">
          <h2 className="text-white font-semibold mb-4">🚨 Anomaly Breakdown</h2>
          {retrobot?.anomaly_breakdown && Object.keys(retrobot.anomaly_breakdown).length > 0 ? (
            <div className="space-y-3 mt-2">
              {Object.entries(retrobot.anomaly_breakdown).map(([type, count]) => (
                <div key={type} className="flex items-center gap-3">
                  <div
                    className="w-3 h-3 rounded-full shrink-0"
                    style={{ backgroundColor: ANOMALY_COLORS[type] ?? "#6b7280" }}
                  />
                  <div className="flex-1">
                    <div className="flex justify-between text-sm">
                      <span className="text-gray-300 capitalize">{type.replace("_", " ")}</span>
                      <span className="text-gray-400">{count} caught</span>
                    </div>
                    <div className="h-1.5 bg-gray-800 rounded-full mt-1">
                      <div
                        className="h-full rounded-full"
                        style={{
                          width: `${(count / (retrobot.anomalies_caught || 1)) * 100}%`,
                          backgroundColor: ANOMALY_COLORS[type] ?? "#6b7280",
                        }}
                      />
                    </div>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="flex items-center justify-center h-32 text-gray-600 text-sm">
              No anomalies yet — agents are warming up
            </div>
          )}
        </div>
      </div>

      {/* Recent Retrobot Catches */}
      {retrobot?.recent_anomalies && retrobot.recent_anomalies.length > 0 && (
        <div className="bg-gray-900/60 border border-gray-800 rounded-2xl p-6">
          <h2 className="text-white font-semibold mb-4">🔍 Recent Retrobot Catches</h2>
          <div className="space-y-3">
            {retrobot.recent_anomalies.slice(0, 5).map((a) => (
              <div
                key={a.id}
                className="flex items-start justify-between p-3 bg-gray-800/50 rounded-xl border border-gray-700/50"
              >
                <div className="flex items-start gap-3">
                  <div
                    className="w-2 h-2 rounded-full mt-1.5 shrink-0"
                    style={{ backgroundColor: ANOMALY_COLORS[a.type] ?? "#6b7280" }}
                  />
                  <div>
                    <div className="text-sm text-gray-200">{a.reason}</div>
                    <div className="text-xs text-gray-500 mt-0.5">
                      {a.buyer} → {a.seller} · {a.amount}
                    </div>
                  </div>
                </div>
                <div className="text-right shrink-0 ml-4">
                  {a.recovered ? (
                    <span className="text-emerald-400 text-xs font-medium">+{a.recovered}</span>
                  ) : (
                    <span className="text-amber-400 text-xs">flagged</span>
                  )}
                  <div className="text-xs text-gray-600 mt-0.5">
                    {a.timestamp ? new Date(a.timestamp).toLocaleTimeString() : ""}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
