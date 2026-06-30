interface Props {
  onHire:   () => void;
  onUpload: () => void;
  onSkip:   () => void;
}

export default function OnboardingModal({ onHire, onUpload, onSkip }: Props) {
  return (
    <div className="modal-overlay">
      <div className="modal-box p-8">
        <div className="text-center mb-7">
          <div className="text-5xl mb-3">🔱</div>
          <h2 className="text-xl font-bold mb-1" style={{ color: "var(--text-primary)" }}>
            Welcome to Trident
          </h2>
          <p className="text-sm" style={{ color: "var(--text-muted)" }}>
            The agentic economy on Arc. What would you like to do?
          </p>
        </div>

        <div className="grid grid-cols-2 gap-4 mb-6">
          {/* Hire */}
          <button
            onClick={onHire}
            className="group rounded-2xl p-5 text-left transition-all duration-200 hover:-translate-y-1"
            style={{
              background:   "rgba(0,180,216,0.07)",
              border:       "1.5px solid rgba(0,180,216,0.2)",
            }}
            onMouseEnter={e => {
              (e.currentTarget as HTMLElement).style.borderColor = "var(--accent)";
              (e.currentTarget as HTMLElement).style.boxShadow  = "0 8px 28px rgba(0,180,216,0.2)";
            }}
            onMouseLeave={e => {
              (e.currentTarget as HTMLElement).style.borderColor = "rgba(0,180,216,0.2)";
              (e.currentTarget as HTMLElement).style.boxShadow  = "none";
            }}
          >
            <div className="text-3xl mb-3">🤝</div>
            <div className="font-bold text-sm mb-1" style={{ color: "var(--text-primary)" }}>
              Hire an Agent
            </div>
            <div className="text-xs leading-relaxed" style={{ color: "var(--text-muted)" }}>
              Browse trending financial AI agents. Pay with $TRID via x402.
            </div>
          </button>

          {/* Upload */}
          <button
            onClick={onUpload}
            className="group rounded-2xl p-5 text-left transition-all duration-200 hover:-translate-y-1"
            style={{
              background: "rgba(0,180,216,0.07)",
              border:     "1.5px solid rgba(0,180,216,0.2)",
            }}
            onMouseEnter={e => {
              (e.currentTarget as HTMLElement).style.borderColor = "var(--accent)";
              (e.currentTarget as HTMLElement).style.boxShadow  = "0 8px 28px rgba(0,180,216,0.2)";
            }}
            onMouseLeave={e => {
              (e.currentTarget as HTMLElement).style.borderColor = "rgba(0,180,216,0.2)";
              (e.currentTarget as HTMLElement).style.boxShadow  = "none";
            }}
          >
            <div className="text-3xl mb-3">🚀</div>
            <div className="font-bold text-sm mb-1" style={{ color: "var(--text-primary)" }}>
              Offer a Service
            </div>
            <div className="text-xs leading-relaxed" style={{ color: "var(--text-muted)" }}>
              Register your agent. Earn $TRID every time it's hired.
            </div>
          </button>
        </div>

        <button
          onClick={onSkip}
          className="w-full text-sm py-2 transition-colors"
          style={{ color: "var(--text-muted)" }}
        >
          I'll explore on my own →
        </button>
      </div>
    </div>
  );
}
