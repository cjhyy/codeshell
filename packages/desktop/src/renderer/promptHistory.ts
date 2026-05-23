/**
 * Per-repo prompt history, persisted to localStorage.
 *
 * Key format: "codeshell.promptHistory.<repoId>" → JSON string[].
 * Cap: HISTORY_LIMIT (20) entries per repo. New prompts push to the
 * front; oldest get dropped. Storing only strings, no metadata —
 * keystroke history with timestamps would be over-engineering for MVP.
 *
 * "global" history (repoId === null) goes under "codeshell.promptHistory.__global__"
 * so users with no active repo still see what they've typed.
 */

export const HISTORY_LIMIT = 20;

function keyFor(repoId: string | null): string {
  return `codeshell.promptHistory.${repoId ?? "__global__"}`;
}

export function loadHistory(repoId: string | null): string[] {
  try {
    const raw = localStorage.getItem(keyFor(repoId));
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((s): s is string => typeof s === "string");
  } catch {
    return [];
  }
}

export function pushHistory(repoId: string | null, prompt: string): string[] {
  const trimmed = prompt.trim();
  if (!trimmed) return loadHistory(repoId);
  const current = loadHistory(repoId);
  // De-dup the immediate predecessor — accidentally hitting Enter twice
  // shouldn't pollute history.
  const filtered = current[0] === trimmed ? current.slice(1) : current;
  const next = [trimmed, ...filtered].slice(0, HISTORY_LIMIT);
  try {
    localStorage.setItem(keyFor(repoId), JSON.stringify(next));
  } catch {
    // best effort
  }
  return next;
}
