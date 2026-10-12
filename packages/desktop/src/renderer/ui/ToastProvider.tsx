/**
 * Transient, non-blocking toast notifications — the lightweight sibling of the
 * modal dialogs in ./DialogProvider. One Provider, one hook:
 *
 *   const toast = useToast();
 *   toast({ message: "已复制路径" });
 *   toast({ message: "保存失败", variant: "error" });
 *
 * Mounted once at the root (see main.tsx). Toasts stack in a corner, auto-expire
 * after their duration (errors stay longer; durationMs: 0 makes them sticky).
 * Dismissing only removes the popup; history stays available in the title bar.
 * The add/dismiss/cap logic lives in the
 * pure ./toastState reducer (unit-tested); this file is the React + timer shell.
 */
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Check, AlertTriangle, Info, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { useT } from "../i18n/I18nProvider";
import {
  initialToastState,
  addToast,
  dismissToast,
  markToastHistoryRead,
  clearToastHistory,
  toastFromOptions,
  type ToastHistoryEntry,
  type ToastOptions,
  type ToastVariant,
} from "./toastState";
import { loadToastHistory, saveToastHistory } from "./toastHistoryStorage";

type ToastFn = (opts: ToastOptions) => void;

const ToastContextRef = createContext<ToastFn | null>(null);
interface ToastHistoryContextValue {
  history: ToastHistoryEntry[];
  markRead: () => void;
  clear: () => void;
}
const ToastHistoryContext = createContext<ToastHistoryContextValue | null>(null);

interface ToastTimer {
  handle?: ReturnType<typeof setTimeout>;
  remainingMs: number;
  startedAt: number;
}

let toastSeq = 0;
function nextToastId(): string {
  toastSeq += 1;
  return `toast-${Date.now()}-${toastSeq}`;
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState(() => initialToastState(loadToastHistory()));
  // Track the auto-dismiss timers so we can clear them on unmount / early
  // dismiss and avoid setState-after-unmount.
  const timers = useRef(new Map<string, ToastTimer>());

  const dismiss = useCallback((id: string) => {
    const timer = timers.current.get(id);
    if (timer?.handle !== undefined) clearTimeout(timer.handle);
    timers.current.delete(id);
    setState((s) => dismissToast(s, id));
  }, []);

  const toast = useCallback<ToastFn>((opts) => {
    const id = nextToastId();
    const full = { id, ...toastFromOptions(opts) };
    const createdAt = Date.now();
    setState((s) => addToast(s, full, createdAt));
    if (full.variant === "error") {
      // Logging must not prevent a notification when the bridge is unavailable.
      try {
        window.codeshell?.log?.("ui.toast.error", {
          message: full.message,
          ...(full.detail !== undefined ? { detail: full.detail } : {}),
          ...(full.sessionId ? { sessionId: full.sessionId } : {}),
        });
      } catch {
        // The history remains available when the log sink fails.
      }
    }
  }, []);

  const pause = useCallback((id: string) => {
    const timer = timers.current.get(id);
    if (!timer || timer.handle === undefined) return;
    clearTimeout(timer.handle);
    timer.handle = undefined;
    timer.remainingMs = Math.max(0, timer.remainingMs - (Date.now() - timer.startedAt));
  }, []);
  const resume = useCallback(
    (id: string) => {
      const timer = timers.current.get(id);
      if (!timer || timer.handle !== undefined) return;
      timer.startedAt = Date.now();
      timer.handle = setTimeout(() => dismiss(id), timer.remainingMs);
    },
    [dismiss],
  );
  const markRead = useCallback(() => setState(markToastHistoryRead), []);
  const clear = useCallback(() => setState(clearToastHistory), []);
  const historyValue = useMemo(
    () => ({ history: state.history, markRead, clear }),
    [state.history, markRead, clear],
  );
  useEffect(() => saveToastHistory(state.history), [state.history]);
  useEffect(() => {
    const active = new Set(state.toasts.map((t) => t.id));
    for (const [id, timer] of timers.current) {
      if (active.has(id)) continue;
      if (timer.handle !== undefined) clearTimeout(timer.handle);
      timers.current.delete(id);
    }
    // Recreate timers on an effect remount too (React StrictMode keeps state
    // while replaying cleanup/setup). Paused timers already in the map stay paused.
    for (const toast of state.toasts) {
      if (toast.durationMs <= 0 || timers.current.has(toast.id)) continue;
      timers.current.set(toast.id, {
        remainingMs: toast.durationMs,
        startedAt: Date.now(),
        handle: setTimeout(() => dismiss(toast.id), toast.durationMs),
      });
    }
  }, [state.toasts, dismiss]);
  useEffect(() => {
    const map = timers.current;
    return () => {
      for (const timer of map.values()) {
        if (timer.handle !== undefined) clearTimeout(timer.handle);
      }
      map.clear();
    };
  }, []);

  return (
    <ToastContextRef.Provider value={toast}>
      <ToastHistoryContext.Provider value={historyValue}>
        {children}
        <div
          className="pointer-events-none fixed bottom-4 right-4 z-[60] flex flex-col gap-2"
          aria-live="polite"
          role="status"
        >
          {state.toasts.map((t) => (
            <ToastCard
              key={t.id}
              variant={t.variant}
              onDismiss={() => dismiss(t.id)}
              onPause={() => pause(t.id)}
              onResume={() => resume(t.id)}
            >
              {t.message}
            </ToastCard>
          ))}
        </div>
      </ToastHistoryContext.Provider>
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

export function useToastHistory(): ToastHistoryContextValue | null {
  return useContext(ToastHistoryContext);
}

const VARIANT_ICON: Record<ToastVariant, React.ReactNode> = {
  default: <Info size={15} className="text-muted-foreground" />,
  success: <Check size={15} className="text-status-ok" />,
  error: <AlertTriangle size={15} className="text-status-err" />,
};

function ToastCard({
  variant,
  onDismiss,
  onPause,
  onResume,
  children,
}: {
  variant: ToastVariant;
  onDismiss: () => void;
  onPause: () => void;
  onResume: () => void;
  children: React.ReactNode;
}) {
  const { t } = useT();
  const hovered = useRef(false);
  return (
    <div
      className={cn(
        "pointer-events-auto flex max-w-sm items-start gap-2 rounded-md border border-border",
        "bg-popover px-3 py-2 text-sm text-popover-foreground shadow-lg",
        "animate-in slide-in-from-bottom-2 fade-in",
      )}
      onMouseEnter={() => {
        hovered.current = true;
        onPause();
      }}
      onMouseLeave={(event) => {
        hovered.current = false;
        if (!event.currentTarget.contains(document.activeElement)) onResume();
      }}
      onFocus={onPause}
      onBlur={(event) => {
        if (!hovered.current && !event.currentTarget.contains(event.relatedTarget)) onResume();
      }}
    >
      <span className="mt-0.5 shrink-0">{VARIANT_ICON[variant]}</span>
      <span className="max-h-48 min-w-0 flex-1 overflow-auto whitespace-pre-wrap break-words select-text">
        {children}
      </span>
      <button
        type="button"
        onClick={onDismiss}
        className="shrink-0 rounded-sm p-0.5 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        aria-label={t("misc.toast.dismiss")}
        title={t("misc.toast.dismiss")}
      >
        <X size={13} />
      </button>
    </div>
  );
}
