/**
 * Per-project prompt history, persisted to the legacy localStorage key.
 *
 * Key format: "codeshell.promptHistory.<projectId>" → JSON string[].
 * Cap: HISTORY_LIMIT (20) entries per project. New prompts push to the
 * front; oldest get dropped. Storing only strings, no metadata —
 * keystroke history with timestamps would be over-engineering for MVP.
 *
 * "global" history (projectId === null) goes under "codeshell.promptHistory.__global__"
 * so users with no active project still see what they've typed.
 */

export const HISTORY_LIMIT = 20;

function keyFor(projectId: string | null): string {
  return `codeshell.promptHistory.${projectId ?? "__global__"}`;
}

export function loadHistory(projectId: string | null): string[] {
  try {
    const raw = localStorage.getItem(keyFor(projectId));
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((s): s is string => typeof s === "string");
  } catch {
    return [];
  }
}

export function pushHistory(projectId: string | null, prompt: string): string[] {
  const trimmed = prompt.trim();
  if (!trimmed) return loadHistory(projectId);
  const current = loadHistory(projectId);
  // De-dup the immediate predecessor — accidentally hitting Enter twice
  // shouldn't pollute history.
  const filtered = current[0] === trimmed ? current.slice(1) : current;
  const next = [trimmed, ...filtered].slice(0, HISTORY_LIMIT);
  try {
    localStorage.setItem(keyFor(projectId), JSON.stringify(next));
  } catch {
    // best effort
  }
  return next;
}
