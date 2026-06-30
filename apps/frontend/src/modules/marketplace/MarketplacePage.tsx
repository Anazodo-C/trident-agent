import { useState, useEffect } from "react";
import { useAccount } from "wagmi";
import axios from "axios";

const API = import.meta.env.VITE_API_URL || "http://localhost:8000";

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

interface Activity {
  id: number;
  buyer: string;
  seller: string;
  amount_display: string;
  service_type: string;
  status: string;
  anomaly_flagged: boolean;
  created_at: string;
}

const SERVICE_ICONS: Record<string, string> = {
  price_feed: "📈", fx_rates: "💱", risk_score: "🛡️",
  compute_score: "⚙️", retrobot_audit: "🔍",
};

function ServiceCard({ svc }: { svc: Service }) {
  const [buying, setBuying] = useState(false);
  const { address } = useAccount();

  const handleBuy = async () => {
    if (!address) { alert("Connect your wallet first"); return; }
    setBuying(true);
    try {
      // In production: GatewayClient.pay(endpoint) handles x402 automatically
      alert(`x402 payment flow for "${svc.name}".\nEndpoint: ${svc.endpoint}\nPrice: ${svc.price_trid_display}\n\nConnected agents pay automatically via GatewayClient.`);
    } finally {
      setBuying(false);
    }
  };

  const tier = svc.seller_reputation >= 8000 ? "Elite" : svc.seller_reputation >= 6000 ? "Premium" :
               svc.seller_reputation >= 4000 ? "Verified" : "Basic";
  const tierColor = tier === "Elite" ? "badge-purple" : tier === "Premium" ? "badge-blue" :
                    tier === "Verified" ? "badge-green" : "badge-yellow";

  return (
    <div className="card hover:border-violet-700/50 transition-colors group">
      <div className="flex items-start justify-between mb-3">
        <div className="flex items-center gap-2">
          <span className="text-2xl">{SERVICE_ICONS[svc.service_type] || "📊"}</span>
          <div>
            <h3 className="font-semibold text-white text-sm">{svc.name}</h3>
            <p className="text-gray-500 text-xs">{svc.seller_name}</p>
          </div>
        </div>
        <span className={`badge ${tierColor}`}>{tier}</span>
      </div>

      <p className="text-gray-400 text-xs mb-4 line-clamp-2">{svc.description || "Financial intelligence service"}</p>

      <div className="flex items-center justify-between text-xs text-gray-500 mb-4">
        <span>⚡ {svc.calls_served.toLocaleString()} calls</span>
        <span>🌟 {(svc.seller_reputation / 100).toFixed(0)}%</span>
        {svc.x402_enabled && <span className="badge badge-green">x402</span>}
      </div>

      <div className="flex items-center justify-between">
        <span className="font-mono text-violet-400 font-medium">{svc.price_trid_display}</span>
        <button onClick={handleBuy} disabled={buying} className="btn-primary text-xs py-1.5 px-3">
          {buying ? "Processing..." : "Buy →"}
        </button>
      </div>
    </div>
  );
}

function ActivityFeed({ activity }: { activity: Activity[] }) {
  return (
    <div className="card">
      <h3 className="font-semibold text-white mb-4 flex items-center gap-2">
        <span className="w-2 h-2 bg-emerald-400 rounded-full animate-pulse" />
        Live Activity
      </h3>
      <div className="space-y-2 max-h-80 overflow-y-auto">
        {activity.length === 0 && <p className="text-gray-600 text-sm text-center py-4">No recent activity</p>}
        {activity.map((a) => (
          <div key={a.id} className="flex items-center justify-between text-xs py-2 border-b border-gray-800 last:border-0">
            <div className="flex items-center gap-2">
              {a.anomaly_flagged && <span title="Anomaly flagged">⚠️</span>}
              <span className="text-gray-400">{a.buyer}</span>
              <span className="text-gray-600">→</span>
              <span className="text-gray-400">{a.seller}</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="font-mono text-violet-400">{a.amount_display}</span>
              <span className={`badge ${a.status === "completed" ? "badge-green" : a.status === "disputed" ? "badge-red" : "badge-yellow"}`}>
                {a.status}
              </span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function MarketplacePage() {
  const [services, setServices] = useState<Service[]>([]);
  const [activity, setActivity] = useState<Activity[]>([]);
  const [filter, setFilter] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const load = async () => {
      try {
        const [svcRes, actRes] = await Promise.all([
          axios.get(`${API}/api/marketplace/services`),
          axios.get(`${API}/api/marketplace/activity/live`),
        ]);
        setServices(svcRes.data.services || []);
        setActivity(actRes.data.activity || []);
      } catch {
        // API not running — show demo data
        setServices(DEMO_SERVICES);
      } finally {
        setLoading(false);
      }
    };
    load();
    const interval = setInterval(() => axios.get(`${API}/api/marketplace/activity/live`)
      .then(r => setActivity(r.data.activity || [])).catch(() => {}), 10_000);
    return () => clearInterval(interval);
  }, []);

  const filtered = services.filter(s =>
    !filter || s.service_type.includes(filter) || s.name.toLowerCase().includes(filter.toLowerCase())
  );

  return (
    <div>
      <div className="mb-8">
        <h1 className="text-3xl font-bold text-white mb-2">
          🔱 Trident Marketplace
        </h1>
        <p className="text-gray-400">
          Buy financial intelligence with <span className="text-violet-400 font-mono">$TRID</span> via Circle Gateway x402 — zero gas, instant settlement.
        </p>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-8">
        {[
          { label: "Services", value: services.length, icon: "🛒" },
          { label: "x402 Enabled", value: services.filter(s => s.x402_enabled).length, icon: "⚡" },
          { label: "Chain", value: "Arc Testnet", icon: "🔗" },
          { label: "Token", value: "$TRID", icon: "💎" },
        ].map(stat => (
          <div key={stat.label} className="stat-box">
            <span className="text-2xl">{stat.icon}</span>
            <span className="text-xl font-bold text-white">{stat.value}</span>
            <span className="text-gray-500 text-xs">{stat.label}</span>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2">
          <div className="flex items-center justify-between mb-4">
            <h2 className="font-semibold text-white">Available Services</h2>
            <input
              className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-sm text-gray-300 placeholder-gray-600 focus:outline-none focus:border-violet-500 w-48"
              placeholder="Search services..."
              value={filter}
              onChange={e => setFilter(e.target.value)}
            />
          </div>
          {loading ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {[...Array(4)].map((_, i) => <div key={i} className="card animate-pulse h-48 bg-gray-900" />)}
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {filtered.map(svc => <ServiceCard key={svc.id} svc={svc} />)}
              {filtered.length === 0 && (
                <div className="col-span-2 text-center py-12 text-gray-600">
                  No services found. Start the backend to load live services.
                </div>
              )}
            </div>
          )}
        </div>
        <div className="space-y-4">
          <ActivityFeed activity={activity} />
          <div className="card">
            <h3 className="font-semibold text-white mb-3">How it works</h3>
            <ol className="space-y-2 text-xs text-gray-400">
              <li className="flex gap-2"><span className="text-violet-400 font-bold">1.</span> Connect wallet to Arc Testnet</li>
              <li className="flex gap-2"><span className="text-violet-400 font-bold">2.</span> Claim $TRID from the faucet (10 TRID free)</li>
              <li className="flex gap-2"><span className="text-violet-400 font-bold">3.</span> Deposit USDC to Circle Gateway</li>
              <li className="flex gap-2"><span className="text-violet-400 font-bold">4.</span> Buy any service — x402 handles payment automatically</li>
              <li className="flex gap-2"><span className="text-violet-400 font-bold">5.</span> Retrobot watches every transaction for anomalies</li>
            </ol>
          </div>
        </div>
      </div>
    </div>
  );
}

const DEMO_SERVICES: Service[] = [
  { id: 1, name: "Price Feed", service_type: "price_feed", description: "Live crypto asset prices via CoinGecko", price_per_call: 1000, price_trid_display: "0.0010 TRID", endpoint: "/data/price-feed", x402_enabled: true, calls_served: 1247, seller_reputation: 8500, seller_name: "Trident Protocol", seller_address: "0x3315..." },
  { id: 2, name: "FX Rates", service_type: "fx_rates", description: "Real-time forex rates including emerging markets (NGN, BRL, GHS)", price_per_call: 1000, price_trid_display: "0.0010 TRID", endpoint: "/data/fx-rates", x402_enabled: true, calls_served: 892, seller_reputation: 8500, seller_name: "Trident Protocol", seller_address: "0x3315..." },
  { id: 3, name: "Risk Score", service_type: "risk_score", description: "Wallet and asset risk scoring powered by on-chain analysis", price_per_call: 5000, price_trid_display: "0.0050 TRID", endpoint: "/data/risk-score", x402_enabled: true, calls_served: 423, seller_reputation: 8500, seller_name: "Trident Protocol", seller_address: "0x3315..." },
  { id: 5, name: "Portfolio Score", service_type: "compute_score", description: "Quantitative portfolio scoring — Sharpe ratio, VaR, drawdown", price_per_call: 20000, price_trid_display: "0.0200 TRID", endpoint: "/data/compute-score", x402_enabled: true, calls_served: 89, seller_reputation: 8500, seller_name: "Trident Protocol", seller_address: "0x3315..." },
  { id: 6, name: "Retrobot Audit", service_type: "retrobot_audit", description: "Full payment history audit — any agent can hire Retrobot", price_per_call: 5000, price_trid_display: "0.0050 TRID", endpoint: "/retrobot/audit", x402_enabled: true, calls_served: 54, seller_reputation: 9200, seller_name: "Retrobot v1.0", seller_address: "0x3315..." },
];
