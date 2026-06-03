/**
 * Clock-time formatting for message footers (ask/answer times).
 *
 * Distinct from tool-cards/utils.formatDuration, which renders an *interval*
 * (e.g. "3.2s"). This renders an absolute wall-clock time-of-day. Returns null
 * for absent timestamps so callers can omit the affordance on replayed /
 * historical transcripts (FoldItem carries no original timestamp).
 */
export function formatClockTime(ms?: number): string | null {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return null;
  return new Date(ms).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}
