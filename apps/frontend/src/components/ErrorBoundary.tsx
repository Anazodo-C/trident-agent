import { Component, ReactNode } from "react";

interface Props  { children: ReactNode; label?: string; }
interface State  { error: Error | null; }

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error) {
    console.error("[ErrorBoundary]", this.props.label, error);
  }

  render() {
    if (this.state.error) {
      return (
        <div
          className="rounded-2xl p-6 m-4 text-center"
          style={{
            background: "rgba(239,68,68,0.08)",
            border:     "1px solid rgba(239,68,68,0.25)",
          }}
        >
          <div className="text-2xl mb-2">⚠️</div>
          <div className="font-semibold text-sm mb-1" style={{ color: "#ef4444" }}>
            {this.props.label ?? "Something went wrong"}
          </div>
          <div className="text-xs mono mb-3" style={{ color: "var(--text-muted)" }}>
            {this.state.error.message}
          </div>
          <button
            className="btn-secondary text-xs"
            onClick={() => this.setState({ error: null })}
          >
            Retry
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
