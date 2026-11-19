import {
  createContext,
  useCallback,
  useContext,
  useRef,
  useState,
  type ReactNode,
} from "react";

const TOAST_DURATION_MS = 2000;
/** Errors get longer on screen, and a longer read is worth a longer look. */
const ERROR_TOAST_DURATION_MS = TOAST_DURATION_MS * 2;

export interface ToastOptions {
  /** Doubles how long the toast stays up and copies it to the clipboard. */
  isError?: boolean;
  /** Extra diagnostic detail appended to the clipboard copy, not shown on screen. */
  context?: string;
}

interface ToastItem {
  id: number;
  message: string;
}

interface ToastContextValue {
  showToast: (message: string, opts?: ToastOptions) => void;
  toasts: ToastItem[];
}

const ToastContext = createContext<ToastContextValue | null>(null);

/**
 * Holds toast state and provides showToast(). Mount <ToastProvider> near the
 * app root and place a single <ToastHost/> inside it.
 */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const nextId = useRef(0);

  const showToast = useCallback((message: string, opts: ToastOptions = {}) => {
    const id = nextId.current++;
    setToasts((current) => [...current, { id, message }]);
    setTimeout(
      () => {
        setToasts((current) => current.filter((t) => t.id !== id));
      },
      opts.isError ? ERROR_TOAST_DURATION_MS : TOAST_DURATION_MS,
    );

    if (opts.isError) {
      const text = opts.context ? `${message}\n\n${opts.context}` : message;
      // Best-effort: clipboard access can be denied (no permission, an
      // insecure context, no user gesture) — the toast itself already shows
      // the message, so a failed copy is not worth surfacing its own error.
      navigator.clipboard?.writeText(text).catch(() => {});
    }
  }, []);

  return (
    <ToastContext.Provider value={{ showToast, toasts }}>
      {children}
    </ToastContext.Provider>
  );
}

/** Renders the live toast stack. Mount exactly once inside <ToastProvider>. */
export function ToastHost() {
  const ctx = useContext(ToastContext);
  if (!ctx) return null;
  return (
    <div className="toast-host" role="status" aria-live="polite">
      {ctx.toasts.map((t) => (
        <div key={t.id} className="toast">
          {t.message}
        </div>
      ))}
    </div>
  );
}

/** Returns showToast(message, opts?). Throws if used outside <ToastProvider>. */
export function useToast(): (message: string, opts?: ToastOptions) => void {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    throw new Error("useToast must be used within a <ToastProvider>");
  }
  return ctx.showToast;
}
