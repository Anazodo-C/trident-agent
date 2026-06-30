// ServiceResultModal — human-readable type-aware result display

interface Props {
  serviceName: string;
  result:      unknown;
  pricePaid:   string;
  onClose:     () => void;
}

// ── helpers ─────────────────────────────────────────────────────────────────
function get(obj: unknown, ...keys: string[]): unknown {
  let cur: unknown = obj;
  for (const k of keys) {
    if (cur === null || cur === undefined || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[k];
  }
  return cur;
}
function str(v: unknown): string { return v == null ? "—" : String(v); }
function num(v: unknown, decimals = 2): string {
  const n = Number(v);
  return isNaN(n) ? "—" : n.toLocaleString(undefined, { maximumFractionDigits: decimals });
}
function pct(v: unknown): string {
  const n = Number(v);
  return isNaN(n) ? str(v) : (n >= 0 ? "+" : "") + n.toFixed(2) + "%";
}

function pretty(val: unknown): string {
  try { return JSON.stringify(val, null, 2); } catch { return String(val); }
}

// ── coin icons ───────────────────────────────────────────────────────────────
const COIN_ICONS: Record<string, string> = {
  BTC: "₿", ETH: "Ξ", USDC: "$", SOL: "◎", BNB: "♦", ADA: "₳",
};

// ── sub-renderers ────────────────────────────────────────────────────────────

function PriceFeedView({ data }: { data: unknown }) {
  const coins = data && typeof data === "object" ? Object.entries(data as Record<string, unknown>) : [];
  return (
    <div className="space-y-2">
      {coins.map(([coin, info]) => {
        const usd    = get(info, "usd") ?? get(info, "price_usd");
        const chg    = get(info, "change_24h");
        const chgNum = Number(chg);
        const up     = !isNaN(chgNum) && chgNum >= 0;
        return (
          <div
            key={coin}
            className="flex items-center justify-between px-4 py-3 rounded-xl"
            style={{ background: "rgba(0,180,216,0.07)", border: "1px solid rgba(0,180,216,0.15)" }}
          >
            <div className="flex items-center gap-3">
              <div
                className="w-9 h-9 rounded-xl flex items-center justify-center font-bold text-base shrink-0"
                style={{ background: "rgba(0,180,216,0.15)", color: "var(--accent)" }}
              >
                {COIN_ICONS[coin] || coin[0]}
              </div>
              <div>
                <div className="font-semibold text-sm" style={{ color: "var(--text-primary)" }}>{coin}</div>
                {chg != null && (
                  <div className="text-xs" style={{ color: up ? "#10b981" : "#ef4444" }}>
                    {up ? "▲" : "▼"} {pct(chg)} 24h
                  </div>
                )}
              </div>
            </div>
            <div className="text-right">
              <div className="font-bold text-sm" style={{ color: "var(--text-primary)" }}>
                ${num(usd, usd != null && Number(usd) > 100 ? 2 : 4)}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

const FX_FLAGS: Record<string, string> = {
  EUR: "🇪🇺", GBP: "🇬🇧", NGN: "🇳🇬", JPY: "🇯🇵",
  BRL: "🇧🇷", GHS: "🇬🇭", CAD: "🇨🇦", AUD: "🇦🇺",
};

function FxRatesView({ data, base }: { data: unknown; base?: unknown }) {
  const baseStr = str(base) || "USD";
  // Handle flat {EUR: 0.92} or old nested {base, rates: {EUR: {rate}}}
  let rateMap: Record<string, unknown> = {};
  if (data && typeof data === "object") {
    const d = data as Record<string, unknown>;
    if (d.rates && typeof d.rates === "object") {
      for (const [k, v] of Object.entries(d.rates as Record<string, unknown>))
        rateMap[k] = typeof v === "object" && v !== null ? (v as any).rate ?? v : v;
    } else {
      rateMap = d;
    }
  }
  const pairs = Object.entries(rateMap).filter(([k]) => !["base", "base_currency", "success", "timestamp", "date"].includes(k));
  return (
    <div>
      <div className="text-xs mb-3 px-1" style={{ color: "var(--text-muted)" }}>
        Base currency: <span className="font-bold" style={{ color: "var(--accent)" }}>{baseStr}</span>
      </div>
      {pairs.length === 0 && (
        <div className="text-center py-4 text-sm" style={{ color: "var(--text-muted)" }}>
          No rate data returned — check backend logs or API key
        </div>
      )}
      <div className="grid grid-cols-2 gap-2">
        {pairs.map(([currency, rate]) => (
          <div
            key={currency}
            className="flex items-center justify-between px-3 py-2.5 rounded-xl"
            style={{ background: "rgba(0,180,216,0.07)", border: "1px solid rgba(0,180,216,0.15)" }}
          >
            <div className="flex items-center gap-2">
              <span className="text-base">{FX_FLAGS[currency] || "🌐"}</span>
              <span className="font-semibold text-sm" style={{ color: "var(--text-primary)" }}>{currency}</span>
            </div>
            <span className="text-sm font-mono" style={{ color: "var(--accent)" }}>
              {num(rate, 4)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function RiskScoreView({ data }: { data: unknown }) {
  const score   = Number(get(data, "risk_score") ?? get(data, "score"));
  const label   = str(get(data, "label") ?? get(data, "risk_label"));
  const factors = get(data, "factors");
  const wallet  = str(get(data, "wallet_address") ?? get(data, "address"));
  const color   = score >= 80 ? "#ef4444" : score >= 50 ? "#f59e0b" : "#10b981";
  const bgColor = score >= 80 ? "rgba(239,68,68,0.1)" : score >= 50 ? "rgba(245,158,11,0.1)" : "rgba(16,185,129,0.1)";
  const borderColor = score >= 80 ? "rgba(239,68,68,0.3)" : score >= 50 ? "rgba(245,158,11,0.3)" : "rgba(16,185,129,0.3)";

  return (
    <div className="space-y-4">
      {/* Score ring */}
      <div
        className="flex items-center gap-4 p-4 rounded-xl"
        style={{ background: bgColor, border: `1px solid ${borderColor}` }}
      >
        <div
          className="w-16 h-16 rounded-full flex items-center justify-center font-black text-xl shrink-0"
          style={{ border: `3px solid ${color}`, color }}
        >
          {isNaN(score) ? "?" : score}
        </div>
        <div>
          <div className="font-bold text-base" style={{ color }}>
            {label || (score >= 80 ? "High Risk" : score >= 50 ? "Medium Risk" : "Low Risk")}
          </div>
          <div className="text-xs mt-0.5" style={{ color: "var(--text-muted)" }}>
            Risk Score / 100
          </div>
          {wallet && wallet !== "—" && (
            <div className="text-xs mt-1 font-mono opacity-60" style={{ color: "var(--text-muted)" }}>
              {wallet.slice(0, 10)}…{wallet.slice(-6)}
            </div>
          )}
        </div>
      </div>
      {/* Factors */}
      {Array.isArray(factors) && factors.length > 0 && (
        <div>
          <div className="text-xs font-semibold mb-2 px-1" style={{ color: "var(--text-muted)" }}>
            Contributing factors
          </div>
          <div className="space-y-1.5">
            {(factors as string[]).map((f, i) => (
              <div key={i} className="flex items-center gap-2 text-sm px-3 py-2 rounded-lg"
                style={{ background: "rgba(0,180,216,0.05)", color: "var(--text-primary)" }}
              >
                <span style={{ color: "var(--accent)" }}>•</span> {f}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function ComputeScoreView({ data }: { data: unknown }) {
  const sharpe  = get(data, "sharpe_ratio");
  const varVal  = get(data, "var_95");
  const maxDD   = get(data, "max_drawdown");
  const signal  = str(get(data, "rebalance_signal") ?? get(data, "signal"));
  const score   = get(data, "score") ?? get(data, "portfolio_score");

  const signalColor = signal === "buy" ? "#10b981" : signal === "sell" ? "#ef4444" : "#f59e0b";

  const metrics = [
    { label: "Sharpe Ratio",   value: num(sharpe, 3),                  color: Number(sharpe) >= 1 ? "#10b981" : "#f59e0b" },
    { label: "VaR (95%)",      value: (Number(varVal) * 100).toFixed(2) + "%", color: "#ef4444" },
    { label: "Max Drawdown",   value: (Number(maxDD)  * 100).toFixed(2) + "%", color: "#ef4444" },
    { label: "Portfolio Score",value: score != null ? String(score) : "—",     color: "var(--accent)" },
  ];

  return (
    <div className="space-y-3">
      {/* Signal banner */}
      {signal && signal !== "—" && (
        <div
          className="flex items-center justify-between px-4 py-3 rounded-xl"
          style={{ background: `${signalColor}15`, border: `1px solid ${signalColor}40` }}
        >
          <span className="text-sm font-semibold" style={{ color: "var(--text-muted)" }}>Rebalance Signal</span>
          <span className="font-black text-base uppercase tracking-wide" style={{ color: signalColor }}>
            {signal === "buy" ? "▲" : signal === "sell" ? "▼" : "◆"} {signal}
          </span>
        </div>
      )}
      {/* Metrics grid */}
      <div className="grid grid-cols-2 gap-2">
        {metrics.map(m => (
          <div
            key={m.label}
            className="px-3 py-3 rounded-xl"
            style={{ background: "rgba(0,180,216,0.07)", border: "1px solid rgba(0,180,216,0.15)" }}
          >
            <div className="text-xs mb-1" style={{ color: "var(--text-muted)" }}>{m.label}</div>
            <div className="font-bold text-base" style={{ color: m.color }}>{m.value}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function RetrobotAuditView({ data }: { data: unknown }) {
  const scanned   = get(data, "total_scanned");
  const caught    = get(data, "anomalies_caught");
  const recovered = str(get(data, "total_recovered") ?? get(data, "total_recovered_display"));
  const rate      = str(get(data, "detection_rate"));
  const status    = str(get(data, "status"));
  const statusOk  = status.includes("active") || status.includes("guardian");

  const stats = [
    { label: "Transactions Scanned", value: num(scanned, 0), color: "var(--accent)" },
    { label: "Anomalies Caught",     value: num(caught, 0),  color: "#f59e0b"        },
    { label: "TRID Recovered",       value: recovered,        color: "#10b981"        },
    { label: "Detection Rate",       value: rate,             color: "#8b5cf6"        },
  ];

  return (
    <div className="space-y-3">
      {/* Status pill */}
      <div
        className="flex items-center gap-2 px-4 py-2.5 rounded-xl"
        style={{ background: statusOk ? "rgba(16,185,129,0.1)" : "rgba(239,68,68,0.1)",
                 border: statusOk ? "1px solid rgba(16,185,129,0.3)" : "1px solid rgba(239,68,68,0.3)" }}
      >
        <span className={`w-2 h-2 rounded-full ${statusOk ? "bg-emerald-400 animate-pulse" : "bg-red-400"}`} />
        <span className="text-sm font-semibold" style={{ color: statusOk ? "#10b981" : "#ef4444" }}>
          {statusOk ? "Retrobot Guardian Active" : "Retrobot Offline"}
        </span>
      </div>
      {/* Stats grid */}
      <div className="grid grid-cols-2 gap-2">
        {stats.map(s => (
          <div
            key={s.label}
            className="px-3 py-3 rounded-xl"
            style={{ background: "rgba(0,180,216,0.07)", border: "1px solid rgba(0,180,216,0.15)" }}
          >
            <div className="text-xs mb-1" style={{ color: "var(--text-muted)" }}>{s.label}</div>
            <div className="font-bold text-base" style={{ color: s.color }}>{s.value}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── type detection ───────────────────────────────────────────────────────────
function detectType(result: unknown): string {
  const svc = str(get(result, "service"));
  if (svc && svc !== "—") return svc;
  // Heuristic from data shape
  const data = get(result, "data");
  if (data && typeof data === "object") {
    const keys = Object.keys(data as object);
    if (keys.includes("BTC") || keys.includes("ETH")) return "price_feed";
    if (keys.includes("EUR") || keys.includes("GBP")) return "fx_rates";
    if (keys.some(k => ["risk_score", "score", "label", "factors"].includes(k))) return "risk_score";
    if (keys.some(k => ["sharpe_ratio", "var_95", "rebalance_signal"].includes(k))) return "compute_score";
    if (keys.some(k => ["total_scanned", "anomalies_caught", "detection_rate"].includes(k))) return "retrobot_audit";
  }
  return "unknown";
}

// ── main component ───────────────────────────────────────────────────────────
export default function ServiceResultModal({ serviceName, result, pricePaid, onClose }: Props) {
  const type    = detectType(result);
  const data    = get(result, "data") ?? result;
  const note    = str(get(result, "note") ?? "");
  const isDemoNote = note && note.toLowerCase().includes("demo");

  function renderBody() {
    switch (type) {
      case "price_feed":        return <PriceFeedView data={data} />;
      case "fx_rates":          return <FxRatesView data={data} base={get(result, "base") ?? "USD"} />;
      case "risk_score":        return <RiskScoreView data={data} />;
      case "compute_score":     return <ComputeScoreView data={data} />;
      case "retrobot_audit":    return <RetrobotAuditView data={data} />;
      default:
        return (
          <pre
            className="whitespace-pre-wrap break-words text-xs mono leading-relaxed"
            style={{ color: "var(--text-secondary)" }}
          >
            {pretty(result)}
          </pre>
        );
    }
  }

  const TYPE_LABELS: Record<string, string> = {
    price_feed:       "Live Price Feed",
    fx_rates:         "FX Exchange Rates",
    risk_score:       "On-chain Risk Score",
    compute_score:    "Portfolio Analysis",
    retrobot_audit:   "Retrobot Audit",
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal-box w-full"
        style={{ maxWidth: 480 }}
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-start justify-between p-6 pb-4">
          <div>
            <div className="flex items-center gap-2 mb-0.5">
              <span className="text-lg">✅</span>
              <h2 className="font-bold text-base" style={{ color: "var(--text-primary)" }}>
                {TYPE_LABELS[type] || serviceName}
              </h2>
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-xs font-mono" style={{ color: "var(--text-muted)" }}>
                {pricePaid} · x402 · Arc Testnet
              </span>
              {isDemoNote && (
                <span
                  className="text-xs px-2 py-0.5 rounded-full font-semibold"
                  style={{ background: "rgba(245,158,11,0.15)", color: "#f59e0b", border: "1px solid rgba(245,158,11,0.3)" }}
                >
                  demo
                </span>
              )}
            </div>
          </div>
          <button onClick={onClose} className="btn-ghost text-lg leading-none -mr-1 -mt-1">✕</button>
        </div>

        {/* Body */}
        <div className="px-6 pb-2 overflow-auto" style={{ maxHeight: "60vh" }}>
          {renderBody()}
        </div>

        {/* Footer */}
        <div className="flex gap-3 p-6 pt-4">
          <button className="btn-primary flex-1" onClick={onClose}>Done</button>
          <button
            className="btn-secondary"
            onClick={() => navigator.clipboard.writeText(pretty(result))}
            title="Copy raw JSON"
          >
            Copy JSON
          </button>
        </div>
      </div>
    </div>
  );
}
