import { useState, useCallback, useEffect, createContext, useContext } from "react";

type ToastType = "success" | "error" | "info" | "loading";

interface ToastItem {
  id: number;
  message: string;
  type: ToastType;
  duration?: number;
}

interface ToastContextValue {
  show: (message: string, type?: ToastType, duration?: number) => number;
  dismiss: (id: number) => void;
}

const ToastContext = createContext<ToastContextValue>({
  show: () => 0,
  dismiss: () => {},
});

export function useToast() {
  return useContext(ToastContext);
}

const ICONS: Record<ToastType, string> = {
  success: "✅",
  error:   "❌",
  info:    "💧",
  loading: "⏳",
};

function ToastItem({ toast, onDismiss }: { toast: ToastItem; onDismiss: () => void }) {
  useEffect(() => {
    if (toast.type === "loading") return;
    const t = setTimeout(onDismiss, toast.duration ?? 3500);
    return () => clearTimeout(t);
  }, [toast, onDismiss]);

  const borderColor =
    toast.type === "success" ? "border-emerald-400/40" :
    toast.type === "error"   ? "border-red-400/40"     :
    toast.type === "loading" ? "border-ocean-400/40"   :
    "border-sky-400/40";

  return (
    <div
      className={`toast ${borderColor}`}
      style={{ bottom: "auto" }}
      role="alert"
    >
      <span className="text-lg leading-none">{ICONS[toast.type]}</span>
      <span className="flex-1 leading-snug">{toast.message}</span>
      {toast.type !== "loading" && (
        <button
          onClick={onDismiss}
          className="text-current opacity-40 hover:opacity-80 ml-1 text-xs leading-none"
          aria-label="Dismiss"
        >
          ✕
        </button>
      )}
    </div>
  );
}

let _counter = 0;

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  const show = useCallback((message: string, type: ToastType = "info", duration = 3500) => {
    const id = ++_counter;
    setToasts(prev => [...prev.slice(-2), { id, message, type, duration }]);
    return id;
  }, []);

  const dismiss = useCallback((id: number) => {
    setToasts(prev => prev.filter(t => t.id !== id));
  }, []);

  return (
    <ToastContext.Provider value={{ show, dismiss }}>
      {children}
      <div className="fixed top-6 left-1/2 -translate-x-1/2 z-[200] flex flex-col gap-2 pointer-events-none">
        {toasts.map(t => (
          <div key={t.id} className="pointer-events-auto">
            <ToastItem toast={t} onDismiss={() => dismiss(t.id)} />
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
