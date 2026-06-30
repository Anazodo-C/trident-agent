import { useState, useEffect } from "react";
import axios from "axios";

const API = import.meta.env.VITE_API_URL || "http://localhost:8000";

interface Agent {
  rank: number;
  wallet_address: string;
  name: string;
  agent_type: string;
  reputation_score: number;
  reputation_pct: number;
  total_jobs: number;
  success_rate: number;
  total_earned: number;
  is_retrobot: boolean;
}

const TIER_CONFIG: Record<string, { color: string; label: string }> = {
  Elite:    { color: "text-purple-400 border-purple-500/30 bg-purple-900/20", label: "🏆 Elite" },
  Premium:  { color: "text-blue-400 border-blue-500/30 bg-blue-900/20", label: "💎 Premium" },
  Verified: { color: "text-emerald-400 border-emerald-500/30 bg-emerald-900/20", label: "✅ Verified" },
  Basic:    { color: "text-yellow-400 border-yellow-500/30 bg-yellow-900/20", label: "🟡 Basic" },
  Probation:{ color: "text-red-400 border-red-500/30 bg-red-900/20", label: "🔴 Probation" },
};

function getTier(score: number) {
  if (score >= 8000) return "Elite";
  if (score >= 6000) return "Premium";
  if (score >= 4000) return "Verified";
  if (score >= 2000) return "Basic";
  return "Probation";
}

function ReputationBar({ score }: { score: number }) {
  const pct = score / 100;
  const tier = getTier(score);
  const barColor = tier === "Elite" ? "bg-purple-500" : tier === "Premium" ? "bg-blue-500" :
                   tier === "Verified" ? "bg-emerald-500" : tier === "Basic" ? "bg-yellow-500" : "bg-red-500";
  return (
    <div className="relative w-full h-2 bg-gray-800 rounded-full overflow-hidden">
      <div className={`h-full ${barColor} rounded-full transition-all duration-500`} style={{ width: `${pct}%` }} />
    </div>
  );
}

function AgentRow({ agent }: { agent: Agent }) {
  const tier = getTier(agent.reputation_score);
  const cfg = TIER_CONFIG[tier];
  const rankIcon = agent.rank === 1 ? "🥇" : agent.rank === 2 ? "🥈" : agent.rank === 3 ? "🥉" : `#${agent.rank}`;

  return (
    <div className="card hover:border-violet-700/40 transition-colors">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-3">
          <span className="text-lg font-bold text-gray-500 w-8">{rankIcon}</span>
          <div>
            <div className="flex items-center gap-2">
              <span className="font-medium text-white text-sm">{agent.name}</span>
              {agent.is_retrobot && <span className="badge badge-purple">Retrobot</span>}
              <span className={`badge text-xs border ${cfg.color}`}>{cfg.label}</span>
            </div>
            <p className="mono text-gray-600 text-xs">{agent.wallet_address.slice(0, 6)}...{agent.wallet_address.slice(-4)}</p>
          </div>
        </div>
        <div className="text-right">
          <p className="font-bold text-white">{agent.reputation_score.toLocaleString()}</p>
          <p className="text-gray-600 text-xs">/ 10,000 bp</p>
        </div>
      </div>

      <ReputationBar score={agent.reputation_score} />

      <div className="grid grid-cols-3 gap-2 mt-3 text-xs text-gray-500">
        <div><p className="text-gray-600">Jobs</p><p className="text-gray-300">{agent.total_jobs}</p></div>
        <div><p className="text-gray-600">Success Rate</p><p className="text-gray-300">{agent.success_rate}%</p></div>
        <div><p className="text-gray-600">Earned</p><p className="mono text-violet-400">{(agent.total_earned / 1e6).toFixed(2)} TRID</p></div>
      </div>
    </div>
  );
}

export default function ReputationPage() {
  const [leaderboard, setLeaderboard] = useState<Agent[]>([]);
  const [loading, setLoading] = useState(true);
  const [bondAddress, setBondAddress] = useState("");
  const [bondAmount, setBondAmount] = useState("5");
  const [bonding, setBonding] = useState(false);

  useEffect(() => {
    const load = async () => {
      try {
        const res = await axios.get(`${API}/api/reputation/leaderboard`);
        setLeaderboard(res.data.leaderboard || []);
      } catch {
        setLeaderboard(DEMO_LEADERBOARD);
      } finally {
        setLoading(false);
      }
    };
    load();
  }, []);

  const handleBond = async () => {
    if (!bondAddress) { alert("Enter a wallet address"); return; }
    setBonding(true);
    try {
      alert(`Bond staking requires calling ReputationBond.postBond(${parseInt(bondAmount) * 1e6}) on Arc Testnet.\nMinimum: 5 TRID\nThis earns +50 reputation points instantly.`);
    } finally {
      setBonding(false);
    }
  };

  return (
    <div>
      <div className="mb-8">
        <h1 className="text-3xl font-bold text-white mb-2">🌟 Reputation System</h1>
        <p className="text-gray-400">
          ERC-8004 on-chain agent identity. Reputation scores (0–10,000 basis points).
          Slash for failures. Bond $TRID to boost your tier.
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2">
          <h2 className="font-semibold text-white mb-4">Agent Leaderboard</h2>
          {loading ? (
            <div className="space-y-4">
              {[...Array(5)].map((_, i) => <div key={i} className="card animate-pulse h-28 bg-gray-900" />)}
            </div>
          ) : (
            <div className="space-y-4">
              {leaderboard.map(a => <AgentRow key={a.wallet_address} agent={a} />)}
              {leaderboard.length === 0 && (
                <div className="card text-center py-12 text-gray-600">
                  No agents registered yet. Start the backend to load live data.
                </div>
              )}
            </div>
          )}
        </div>

        <div className="space-y-4">
          {/* Tier guide */}
          <div className="card">
            <h3 className="font-semibold text-white mb-3">Reputation Tiers</h3>
            <div className="space-y-2">
              {Object.entries(TIER_CONFIG).map(([tier, cfg]) => (
                <div key={tier} className={`flex items-center justify-between rounded-lg px-3 py-2 border ${cfg.color}`}>
                  <span className="text-sm font-medium">{cfg.label}</span>
                  <span className="text-xs font-mono">
                    {tier === "Elite" ? "8000+" : tier === "Premium" ? "6000+" : tier === "Verified" ? "4000+" : tier === "Basic" ? "2000+" : "0+"}
                  </span>
                </div>
              ))}
            </div>
          </div>

          {/* Bond staking */}
          <div className="card">
            <h3 className="font-semibold text-white mb-3">Post Reputation Bond</h3>
            <p className="text-gray-500 text-xs mb-4">
              Stake $TRID to boost your reputation tier. Minimum: 5 TRID.
              Slashed automatically by Retrobot on confirmed failures.
            </p>
            <div className="space-y-3">
              <input
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-300 placeholder-gray-600 focus:outline-none focus:border-violet-500"
                placeholder="Your wallet address (0x...)"
                value={bondAddress}
                onChange={e => setBondAddress(e.target.value)}
              />
              <div className="flex gap-2">
                <input
                  type="number"
                  min="5"
                  className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-300 focus:outline-none focus:border-violet-500"
                  value={bondAmount}
                  onChange={e => setBondAmount(e.target.value)}
                />
                <span className="flex items-center text-sm text-violet-400 font-mono">TRID</span>
              </div>
              <button onClick={handleBond} disabled={bonding} className="btn-primary w-full">
                {bonding ? "Processing..." : "🔒 Post Bond"}
              </button>
            </div>
          </div>

          {/* Scoring guide */}
          <div className="card">
            <h3 className="font-semibold text-white mb-3">How Scores Change</h3>
            <div className="space-y-2 text-xs">
              {[
                { label: "Successful job", delta: "+10 bp", color: "text-emerald-400" },
                { label: "Post bond", delta: "+50 bp", color: "text-emerald-400" },
                { label: "Job failure", delta: "-200 bp", color: "text-red-400" },
                { label: "Retrobot slash", delta: "-300 bp", color: "text-red-400" },
                { label: "Bond slashed", delta: "-500 bp", color: "text-red-400" },
              ].map(r => (
                <div key={r.label} className="flex justify-between">
                  <span className="text-gray-500">{r.label}</span>
                  <span className={`font-mono font-medium ${r.color}`}>{r.delta}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

const DEMO_LEADERBOARD: Agent[] = [
  { rank: 1, wallet_address: "0x3315ebaab06d6266e92f6063b9360ae10d24F0a0", name: "Retrobot v1.0",  agent_type: "retrobot", reputation_score: 9200, reputation_pct: 92, total_jobs: 1847, success_rate: 99.2, total_earned: 18470000, is_retrobot: true  },
  { rank: 2, wallet_address: "0xabc1000000000000000000000000000000000001", name: "AlphaBot",       agent_type: "seller",   reputation_score: 8500, reputation_pct: 85, total_jobs: 423,  success_rate: 97.4, total_earned: 8460000, is_retrobot: false },
  { rank: 3, wallet_address: "0xabc2000000000000000000000000000000000002", name: "DataMaven",      agent_type: "seller",   reputation_score: 8100, reputation_pct: 81, total_jobs: 309,  success_rate: 95.8, total_earned: 6180000, is_retrobot: false },
  { rank: 4, wallet_address: "0xabc4000000000000000000000000000000000004", name: "Alpha Buyer",    agent_type: "buyer",    reputation_score: 7400, reputation_pct: 74, total_jobs: 312,  success_rate: 94.2, total_earned: 0,       is_retrobot: false },
  { rank: 5, wallet_address: "0xabc5000000000000000000000000000000000005", name: "Beta Buyer",     agent_type: "buyer",    reputation_score: 6800, reputation_pct: 68, total_jobs: 241,  success_rate: 91.3, total_earned: 0,       is_retrobot: false },
  { rank: 6, wallet_address: "0xabc6000000000000000000000000000000000006", name: "Gamma Buyer",    agent_type: "buyer",    reputation_score: 6300, reputation_pct: 63, total_jobs: 198,  success_rate: 89.4, total_earned: 0,       is_retrobot: false },
];
