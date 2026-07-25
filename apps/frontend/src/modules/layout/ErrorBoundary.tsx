import { Component, type ErrorInfo, type ReactNode } from 'react'
import { AlertTriangle } from 'lucide-react'

interface Props {
  children: ReactNode
}
interface State {
  error: Error | null
}

export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[trident] render error', error, info.componentStack)
  }

  override render(): ReactNode {
    const { error } = this.state
    if (!error) return this.props.children

    return (
      <div className="flex min-h-screen items-center justify-center px-4">
        <div className="panel max-w-md p-6">
          <div className="mb-4 flex items-center gap-2.5 text-[#FF4466]">
            <AlertTriangle className="h-5 w-5" />
            <h1 className="font-mono text-sm uppercase tracking-widest">Interface Fault</h1>
          </div>
          <p className="mb-5 text-sm text-slate-400">
            Something broke while rendering. Reloading usually clears it.
          </p>
          <pre className="mb-5 max-h-40 overflow-auto rounded-lg border border-[#1A7FFF]/20 bg-[#0A0E1A] p-3 font-mono text-[11px] text-slate-500">
            {error.message}
          </pre>
          <button className="btn-primary w-full" onClick={() => window.location.reload()}>
            Reload
          </button>
        </div>
      </div>
    )
  }
}
