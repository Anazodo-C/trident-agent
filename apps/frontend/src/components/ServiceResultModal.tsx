interface Props {
  serviceName: string;
  result:      unknown;
  pricePaid:   string;
  onClose:     () => void;
}

function pretty(val: unknown): string {
  try {
    return JSON.stringify(val, null, 2);
  } catch {
    return String(val);
  }
}

export default function ServiceResultModal({ serviceName, result, pricePaid, onClose }: Props) {
  const isObj = typeof result === "object" && result !== null;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal-box p-6 max-w-lg w-full"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-start justify-between mb-4">
          <div>
            <div className="flex items-center gap-2">
              <span className="text-xl">✅</span>
              <h2 className="font-bold text-base" style={{ color: "var(--text-primary)" }}>
                {serviceName} — Response
              </h2>
            </div>
            <div className="text-xs mt-0.5 font-mono" style={{ color: "var(--text-muted)" }}>
              Paid: {pricePaid} · via x402 · Arc Testnet
            </div>
          </div>
          <button
            onClick={onClose}
            className="btn-ghost text-lg leading-none -mr-1 -mt-1"
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        {/* Result */}
        <div
          className="rounded-xl p-4 overflow-auto max-h-72 mono text-xs leading-relaxed"
          style={{
            background: "rgba(0,180,216,0.06)",
            border:     "1px solid rgba(0,180,216,0.2)",
            color:      "var(--text-secondary)",
          }}
        >
          {isObj ? (
            <pre className="whitespace-pre-wrap break-words">{pretty(result)}</pre>
          ) : (
            <span>{String(result)}</span>
          )}
        </div>

        <div className="flex gap-3 mt-5">
          <button className="btn-primary flex-1" onClick={onClose}>Done</button>
          <button
            className="btn-secondary"
            onClick={() => navigator.clipboard.writeText(pretty(result))}
          >
            Copy
          </button>
        </div>
      </div>
    </div>
  );
}
