import { MAX_TOAST_HISTORY, type ToastHistoryEntry } from "./toastState";

export const TOAST_HISTORY_STORAGE_KEY = "codeshell.notificationHistory.v1";

function isToastHistoryEntry(value: unknown): value is ToastHistoryEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.id === "string" &&
    entry.id.length > 0 &&
    typeof entry.message === "string" &&
    (entry.detail === undefined || typeof entry.detail === "string") &&
    (entry.sessionId === undefined ||
      (typeof entry.sessionId === "string" && entry.sessionId.trim().length > 0)) &&
    (entry.variant === "default" || entry.variant === "success" || entry.variant === "error") &&
    typeof entry.durationMs === "number" &&
    Number.isFinite(entry.durationMs) &&
    entry.durationMs >= 0 &&
    typeof entry.createdAt === "number" &&
    entry.createdAt >= 0 &&
    Number.isFinite(new Date(entry.createdAt).getTime()) &&
    typeof entry.read === "boolean"
  );
}

/** Window-local history survives reloads without other windows overwriting it. */
export function loadToastHistory(): ToastHistoryEntry[] {
  try {
    const raw = globalThis.sessionStorage?.getItem(TOAST_HISTORY_STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isToastHistoryEntry).slice(-MAX_TOAST_HISTORY);
  } catch {
    return [];
  }
}

export function saveToastHistory(entries: readonly ToastHistoryEntry[]): void {
  try {
    globalThis.sessionStorage?.setItem(
      TOAST_HISTORY_STORAGE_KEY,
      JSON.stringify(entries.slice(-MAX_TOAST_HISTORY)),
    );
  } catch {
    // History remains in memory when storage is unavailable or full.
  }
}
