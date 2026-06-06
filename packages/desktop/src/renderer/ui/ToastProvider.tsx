/**
 * Transient, non-blocking toast notifications — the lightweight sibling of the
 * modal dialogs in ./DialogProvider. One Provider, one hook:
 *
 *   const toast = useToast();
 *   toast({ message: "已复制路径" });
 *   toast({ message: "保存失败", variant: "error" });
 *
 * Mounted once at the root (see main.tsx). Toasts stack in a corner, auto-expire
 * after their duration (default ~2.6s; pass durationMs: 0 to make them sticky),
 * and can be clicked to dismiss early. The add/dismiss/cap logic lives in the
 * pure ./toastState reducer (unit-tested); this file is the React + timer shell.
 */
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { Check, AlertTriangle, Info, X } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  initialToastState,
  addToast,
  dismissToast,
  toastFromOptions,
  type ToastOptions,
  type ToastVariant,
} from "./toastState";

type ToastFn = (opts: ToastOptions) => void;

const ToastContextRef = createContext<ToastFn | null>(null);

let toastSeq = 0;
function nextToastId(): string {
  toastSeq += 1;
  return `toast-${toastSeq}`;
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState(initialToastState);
  // Track the auto-dismiss timers so we can clear them on unmount / early
  // dismiss and avoid setState-after-unmount.
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((id: string) => {
    const t = timers.current.get(id);
    if (t) {
      clearTimeout(t);
      timers.current.delete(id);
    }
    setState((s) => dismissToast(s, id));
  }, []);

  const toast = useCallback<ToastFn>(
    (opts) => {
      const id = nextToastId();
      const full = { id, ...toastFromOptions(opts) };
      setState((s) => addToast(s, full));
      if (full.durationMs > 0) {
        timers.current.set(
          id,
          setTimeout(() => dismiss(id), full.durationMs),
        );
      }
    },
    [dismiss],
  );

  useEffect(() => {
    const map = timers.current;
    return () => {
      for (const t of map.values()) clearTimeout(t);
      map.clear();
    };
  }, []);

  return (
    <ToastContextRef.Provider value={toast}>
      {children}
      <div
        className="pointer-events-none fixed bottom-4 right-4 z-[60] flex flex-col gap-2"
        aria-live="polite"
        role="status"
      >
        {state.toasts.map((t) => (
          <ToastCard key={t.id} variant={t.variant} onDismiss={() => dismiss(t.id)}>
            {t.message}
          </ToastCard>
        ))}
      </div>
    </ToastContextRef.Provider>
  );
}

const NOOP_TOAST: ToastFn = () => {};

/**
 * The hook callers use to raise a toast. A toast is non-critical UX, so when no
 * ToastProvider is mounted (e.g. a component rendered in isolation by a test,
 * or the browser popout window) this returns a no-op rather than throwing —
 * the action still succeeds, it just shows no confirmation.
 */
export function useToast(): ToastFn {
  return useContext(ToastContextRef) ?? NOOP_TOAST;
}

const VARIANT_ICON: Record<ToastVariant, React.ReactNode> = {
  default: <Info size={15} className="text-muted-foreground" />,
  success: <Check size={15} className="text-status-ok" />,
  error: <AlertTriangle size={15} className="text-status-err" />,
};

function ToastCard({
  variant,
  onDismiss,
  children,
}: {
  variant: ToastVariant;
  onDismiss: () => void;
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "pointer-events-auto flex max-w-sm items-start gap-2 rounded-md border border-border",
        "bg-popover px-3 py-2 text-sm text-popover-foreground shadow-lg",
        "animate-in slide-in-from-bottom-2 fade-in",
      )}
      onClick={onDismiss}
      role="button"
      title="点击关闭"
    >
      <span className="mt-0.5 shrink-0">{VARIANT_ICON[variant]}</span>
      <span className="min-w-0 flex-1 break-words">{children}</span>
      <X size={13} className="mt-0.5 shrink-0 text-muted-foreground" />
    </div>
  );
}
