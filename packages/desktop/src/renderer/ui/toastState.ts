/**
 * Pure state behind the toast hook (useToast). Kept free of React/DOM/timers so
 * the add/dismiss/cap behaviour is unit-testable; the ToastProvider owns the
 * id generation, the auto-dismiss timers, and the rendering.
 *
 * Toasts are non-blocking, transient confirmations ("已复制路径", "图片已保存")
 * — distinct from the modal dialogs in ./dialogState. Several can be visible at
 * once; the newest sits at the bottom of the stack.
 */

export type ToastVariant = "default" | "success" | "error";

export interface ToastOptions {
  message: string;
  /** Affects the accent/icon. Default "default". */
  variant?: ToastVariant;
  /** Auto-dismiss after this many ms; 0 means it stays until dismissed. */
  durationMs?: number;
}

export interface Toast {
  id: string;
  message: string;
  variant: ToastVariant;
  durationMs: number;
}

export const DEFAULT_TOAST_DURATION_MS = 2600;

/** Cap concurrent toasts so a burst can't bury the UI; oldest fall off. */
export const MAX_TOASTS = 4;

export interface ToastState {
  toasts: Toast[];
}

export function initialToastState(): ToastState {
  return { toasts: [] };
}

/**
 * Add a toast (already assigned an id by the provider). When the stack is at
 * MAX_TOASTS the oldest is dropped so the newest is always visible.
 */
export function addToast(state: ToastState, toast: Toast): ToastState {
  const next = [...state.toasts, toast];
  if (next.length > MAX_TOASTS) next.splice(0, next.length - MAX_TOASTS);
  return { toasts: next };
}

/** Remove a toast by id. No-op if it's already gone. */
export function dismissToast(state: ToastState, id: string): ToastState {
  const toasts = state.toasts.filter((t) => t.id !== id);
  if (toasts.length === state.toasts.length) return state;
  return { toasts };
}

/** Normalise caller options into a full Toast (minus the id). */
export function toastFromOptions(opts: ToastOptions): Omit<Toast, "id"> {
  return {
    message: opts.message,
    variant: opts.variant ?? "default",
    durationMs: opts.durationMs ?? DEFAULT_TOAST_DURATION_MS,
  };
}
