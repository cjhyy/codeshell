/**
 * Pure state behind the toast hook (useToast). Kept free of React/DOM/timers so
 * the active-stack and history behaviour is unit-testable; the ToastProvider owns the
 * id generation, the auto-dismiss timers, and the rendering.
 *
 * Toasts are non-blocking, transient confirmations ("已复制路径", "图片已保存")
 * — distinct from the modal dialogs in ./dialogState. Several can be visible at
 * once; the newest sits at the bottom of the stack.
 */

export type ToastVariant = "default" | "success" | "error";

export interface ToastOptions {
  message: string;
  /** Full diagnostic context retained in notification history. */
  detail?: string;
  /** Affects the accent/icon. Default "default". */
  variant?: ToastVariant;
  /** Auto-dismiss after this many ms; 0 means it stays until dismissed. */
  durationMs?: number;
}

export interface Toast {
  id: string;
  message: string;
  detail?: string;
  variant: ToastVariant;
  durationMs: number;
}

export interface ToastHistoryEntry extends Toast {
  createdAt: number;
  read: boolean;
}

export const DEFAULT_TOAST_DURATION_MS = 2600;
export const ERROR_TOAST_DURATION_MS = 8000;

/** Cap concurrent toasts so a burst can't bury the UI; oldest fall off. */
export const MAX_TOASTS = 4;
export const MAX_TOAST_HISTORY = 100;

export interface ToastState {
  toasts: Toast[];
  history: ToastHistoryEntry[];
}

export function initialToastState(history: ToastHistoryEntry[] = []): ToastState {
  return { toasts: [], history: history.slice(-MAX_TOAST_HISTORY) };
}

/**
 * Add a toast (already assigned an id by the provider). When the stack is at
 * MAX_TOASTS the oldest is dropped so the newest is always visible.
 */
export function addToast(state: ToastState, toast: Toast, createdAt = Date.now()): ToastState {
  const next = [...state.toasts, toast];
  if (next.length > MAX_TOASTS) next.splice(0, next.length - MAX_TOASTS);
  const history = [...state.history, { ...toast, createdAt, read: false }].slice(
    -MAX_TOAST_HISTORY,
  );
  return { toasts: next, history };
}

/** Remove an active toast by id while keeping its history. */
export function dismissToast(state: ToastState, id: string): ToastState {
  const toasts = state.toasts.filter((t) => t.id !== id);
  if (toasts.length === state.toasts.length) return state;
  return { ...state, toasts };
}

export function markToastHistoryRead(state: ToastState): ToastState {
  if (state.history.every((entry) => entry.read)) return state;
  return {
    ...state,
    history: state.history.map((entry) => (entry.read ? entry : { ...entry, read: true })),
  };
}

/** Clearing the history must not dismiss active notifications. */
export function clearToastHistory(state: ToastState): ToastState {
  if (state.history.length === 0) return state;
  return { ...state, history: [] };
}

/** Normalise caller options into a full Toast (minus the id). */
export function toastFromOptions(opts: ToastOptions): Omit<Toast, "id"> {
  return {
    message: opts.message,
    ...(opts.detail !== undefined ? { detail: opts.detail } : {}),
    variant: opts.variant ?? "default",
    durationMs:
      opts.durationMs ??
      (opts.variant === "error" ? ERROR_TOAST_DURATION_MS : DEFAULT_TOAST_DURATION_MS),
  };
}
