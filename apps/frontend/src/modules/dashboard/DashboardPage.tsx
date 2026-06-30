import { useState, useEffect } from "react";
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

interface VolumePoint { time: string; volume: number; transactions: number; recovered: number; }

interface RetrobotStats {
  total_scanned: number;
  anomalies_caught: number;
  total_recovered_display: string;
  detection_rate: string;
  anomaly_breakdown: Record<string, number>;
  recent_anomalies: {
    id: number; buyer: string; seller: string; amount: string;
    type: string; reason: string; recovered: string | null;
    status: string; timestamp: string;
  }[];
}

const DEMO_VOLUME: VolumePoint[] = Array.from({ length: 12 }, (_, i) => ({
  time: `${(i * 2).toString().padStart(2, "0")}:00`,
  volume:       parseFloat((Math.random() * 2 + 0.1).toFixed(3)),
  transactions: Math.floor(Math.random() * 8) + 1,
  recovered:    parseFloat((Math.random() * 0.3).toFixed(3)),
}));

const ANOMALY_COLORS: Record<string, string> = {
  overpayment:    "#f59e0b",
  duplicate:      "#ef4444",
  failed_delivery:"#8b5cf6",
};

const CHART_STYLE = {
  backgroundColor: "var(--bg-card)",
  border:          "1px solid var(--border)",
  borderRadius:    12,
  color:           "var(--text-primary)",
};

export default function DashboardPage() {
  const [overview,    setOverview]    = useState<Overview | null>(null);
  const [volumeData,  setVolumeData]  = useState<VolumePoint[]>(DEMO_VOLUME);
  const [retrobot,    setRetrobot]    = useState<RetrobotStats | null>(null);
  const [loading,     setLoading]     = useState(true);

  const fetchAll = async () => {
    const [ov, vol, rb] = await Promise.allSettled([
      axios.get(`${API}/api/stats/overview`),
      axios.get(`${API}/api/stats/volume?hours=24`),
      axios.get(`${API}/api/stats/retrobot`),
    ]);
    if (ov.status  === "fulfilled") setOverview(ov.value.data);
    if (vol.status === "fulfilled" && vol.value.data.data?.length > 0)
      setVolumeData(vol.value.data.data);
    if (rb.status  === "fulfilled") setRetrobot(rb.value.data);
    setLoading(false);
  };

  useEffect(() => {
    fetchAll();
    const iv = setInterval(fetchAll, 15_000);
    return () => clearInterval(iv);
  }, []);

  const stat = (label: string, value: string | number | undefined, sub: string, color: string) => (
    <div
      key={label}
      className="card flex flex-col gap-1"
      style={{ borderLeft: `3px solid ${color}` }}
    >
      <div className="text-2xl font-bold" style={{ color }}>{value ?? "—"}</div>
      <div className="text-sm font-medium" style={{ color: "var(--text-primary)" }}>{label}</div>
      <div className="text-xs" style={{ color: "var(--text-muted)" }}>{sub}</div>
    </div>
  );

  return (
    <div className="space-y-8">
      {/* Header */}
      <div>
        <h1 className="text-3xl font-bold flex items-center gap-3" style={{ color: "var(--text-primary)" }}>
          <span>📊</span> Live Dashboard
        </h1>
        <p className="mt-1 text-sm" style={{ color: "var(--text-muted)" }}>
          Autonomous agent activity — real-time volume, Retrobot recoveries, anomaly detection.
        </p>
      </div>

      {/* Retrobot Hero */}
      <div
        className="rounded-2xl p-6"
        style={{
          background: "linear-gradient(135deg, rgba(2,62,138,0.22) 0%, rgba(0,150,199,0.14) 100%)",
          border:     "1.5px solid rgba(0,180,216,0.3)",
        }}
      >
        <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-5">
          <div>
            <div className="flex items-center gap-2 mb-1.5">
              <span className="text-2xl">🤖</span>
              <span className="font-bold text-lg" style={{ color: "var(--text-primary)" }}>
                Retrobot — Payment Guardian
              </span>
              <span
                className="text-xs px-2 py-0.5 rounded-full font-semibold"
                style={{ background: "rgba(16,185,129,0.15)", color: "#10b981", border: "1px solid rgba(16,185,129,0.3)" }}
              >
                LIVE
              </span>
            </div>
            <p className="text-sm max-w-xl" style={{ color: "var(--text-muted)" }}>
              Scans every agent transaction with LangChain + Claude. Autonomously detects overpayments,
              duplicates, failed deliveries — executes on-chain recovery via TridentEscrow.
            </p>
          </div>
          <div className="flex gap-7 text-center shrink-0">
            {[
              { v: retrobot?.total_recovered_display ?? "0 TRID", l: "Recovered",    c: "#10b981" },
              { v: retrobot?.detection_rate ?? "0%",              l: "Detection",     c: "#f59e0b" },
              { v: retrobot?.total_scanned ?? 0,                  l: "Tx Scanned",   c: "var(--accent)" },
            ].map(s => (
              <div key={s.l}>
                <div className="text-2xl font-bold" style={{ color: s.c }}>{s.v}</div>
                <div className="text-xs" style={{ color: "var(--text-muted)" }}>{s.l}</div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {stat("Total Volume",   overview?.total_volume_display ?? "—",        `${overview?.transactions_24h ?? 0} tx today`,      "#00b4d8")}
        {stat("Recovered",      overview?.total_recovered_display ?? "—",     `${overview?.anomalies_caught ?? 0} anomalies`,     "#10b981")}
        {stat("Active Agents",  overview?.active_agents ?? "—",               `${overview?.active_services ?? 0} services live`, "#8b5cf6")}
        {stat("Recovery Rate",  overview?.retrobot_recovery_rate ?? "—",      "of flagged volume",                                "#f59e0b")}
      </div>

      {/* Volume Chart */}
      <div className="card">
        <h2 className="font-semibold mb-5 flex items-center gap-2" style={{ color: "var(--text-primary)" }}>
          📈 TRID Volume (24h)
        </h2>
        <ResponsiveContainer width="100%" height={260}>
          <LineChart data={volumeData}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
            <XAxis dataKey="time" tick={{ fill: "var(--text-muted)", fontSize: 11 }} />
            <YAxis tick={{ fill: "var(--text-muted)", fontSize: 11 }} />
            <Tooltip contentStyle={CHART_STYLE} />
            <Legend />
            <Line type="monotone" dataKey="volume"    stroke="#00b4d8" strokeWidth={2} dot={false} name="Volume (TRID)" />
            <Line type="monotone" dataKey="recovered" stroke="#10b981" strokeWidth={2} dot={false} name="Recovered (TRID)" />
          </LineChart>
        </ResponsiveContainer>
      </div>

      {/* Tx Chart + Anomaly Breakdown */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="card">
          <h2 className="font-semibold mb-4" style={{ color: "var(--text-primary)" }}>
            ⚡ Transactions per Hour
          </h2>
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={volumeData}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
              <XAxis dataKey="time" tick={{ fill: "var(--text-muted)", fontSize: 10 }} />
              <YAxis  tick={{ fill: "var(--text-muted)", fontSize: 10 }} />
              <Tooltip contentStyle={CHART_STYLE} />
              <Bar dataKey="transactions" fill="#0096c7" radius={[4, 4, 0, 0]} name="Transactions" />
            </BarChart>
          </ResponsiveContainer>
        </div>

        <div className="card">
          <h2 className="font-semibold mb-4" style={{ color: "var(--text-primary)" }}>
            🚨 Anomaly Breakdown
          </h2>
          {retrobot?.anomaly_breakdown && Object.keys(retrobot.anomaly_breakdown).length > 0 ? (
            <div className="space-y-3 mt-1">
              {Object.entries(retrobot.anomaly_breakdown).map(([type, count]) => (
                <div key={type} className="flex items-center gap-3">
                  <div className="w-3 h-3 rounded-full shrink-0" style={{ background: ANOMALY_COLORS[type] ?? "#6b7280" }} />
                  <div className="flex-1">
                    <div className="flex justify-between text-sm mb-1">
                      <span className="capitalize" style={{ color: "var(--text-secondary)" }}>{type.replace("_", " ")}</span>
                      <span style={{ color: "var(--text-muted)" }}>{count} caught</span>
                    </div>
                    <div className="h-1.5 rounded-full" style={{ background: "var(--border)" }}>
                      <div
                        className="h-full rounded-full"
                        style={{
                          width:      `${(count / (retrobot.anomalies_caught || 1)) * 100}%`,
                          background: ANOMALY_COLORS[type] ?? "#6b7280",
                        }}
                      />
                    </div>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div
              className="flex items-center justify-center h-32 text-sm"
              style={{ color: "var(--text-muted)" }}
            >
              {loading ? "Loading…" : "Agents are warming up — anomalies appear here"}
            </div>
          )}
        </div>
      </div>

      {/* Recent Catches */}
      {(retrobot?.recent_anomalies?.length ?? 0) > 0 && (
        <div className="card">
          <h2 className="font-semibold mb-4" style={{ color: "var(--text-primary)" }}>
            🔍 Recent Retrobot Catches
          </h2>
          <div className="space-y-3">
            {retrobot!.recent_anomalies.slice(0, 5).map(a => (
              <div
                key={a.id}
                className="flex items-start justify-between p-3 rounded-xl"
                style={{ background: "rgba(0,180,216,0.05)", border: "1px solid rgba(0,180,216,0.12)" }}
              >
                <div className="flex items-start gap-3">
                  <div
                    className="w-2 h-2 rounded-full mt-1.5 shrink-0"
                    style={{ background: ANOMALY_COLORS[a.type] ?? "#6b7280" }}
                  />
                  <div>
                    <div className="text-sm" style={{ color: "var(--text-primary)" }}>{a.reason}</div>
                    <div className="text-xs mt-0.5 mono" style={{ color: "var(--text-muted)" }}>
                      {a.buyer} → {a.seller} · {a.amount}
                    </div>
                  </div>
                </div>
                <div className="text-right shrink-0 ml-4">
                  {a.recovered ? (
                    <span className="text-emerald-500 text-xs font-medium">+{a.recovered}</span>
                  ) : (
                    <span className="text-amber-500 text-xs">flagged</span>
                  )}
                  <div className="text-xs mt-0.5" style={{ color: "var(--text-muted)" }}>
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
