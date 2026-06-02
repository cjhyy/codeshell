/**
 * Pure state machine behind the command-imperative dialog hooks
 * (useConfirm / useAlert / usePrompt). Kept free of React/DOM so the
 * one-dialog-at-a-time queueing and resolver wiring is unit-testable.
 *
 * A request carries its own `resolve` (the Promise resolver from the hook
 * call); the reducer never knows what a caller awaits — it just hands the
 * value back when the active dialog is dismissed and promotes the next.
 */

export type DialogKind = "confirm" | "alert" | "prompt";

export interface ConfirmDialogOptions {
  title?: string;
  message: string;
  detail?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
}

export interface AlertDialogOptions {
  title?: string;
  message: string;
  detail?: string;
  /** Single dismiss button label. Default "知道了". */
  okLabel?: string;
}

export interface PromptDialogOptions {
  title?: string;
  message: string;
  detail?: string;
  /** Pre-filled value. */
  defaultValue?: string;
  placeholder?: string;
  confirmLabel?: string;
  cancelLabel?: string;
}

/**
 * A queued dialog. `resolve` is the matching Promise resolver:
 *   - confirm → boolean   (ok / cancel)
 *   - alert   → void       (dismiss)
 *   - prompt  → string|null (entered text / cancel)
 */
export interface DialogRequest {
  kind: DialogKind;
  options: ConfirmDialogOptions | AlertDialogOptions | PromptDialogOptions;
  resolve: (value: unknown) => void;
}

export interface DialogState {
  active: DialogRequest | null;
  queue: DialogRequest[];
}

export function initialDialogState(): DialogState {
  return { active: null, queue: [] };
}

/** Add a request. Becomes active if nothing is showing, else queued. */
export function enqueue(state: DialogState, req: DialogRequest): DialogState {
  if (state.active === null) return { active: req, queue: state.queue };
  return { active: state.active, queue: [...state.queue, req] };
}

/**
 * Resolve the active dialog with `value`, then promote the next queued
 * request (if any). No-op when nothing is active. The caller passes the
 * kind-appropriate value (boolean / void / string|null).
 */
export function resolveActive(state: DialogState, value: unknown): DialogState {
  if (state.active === null) return state;
  state.active.resolve(value);
  const [next, ...rest] = state.queue;
  return { active: next ?? null, queue: rest };
}
