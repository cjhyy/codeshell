import type { AskUserOption } from "../types";

export type AskUserTone = "ok" | "danger" | "neutral";

/**
 * Resolve the semantic tone for a *resolved* AskUserQuestion answer.
 *
 * The answer is a plain string (the chosen label, or comma-joined labels for
 * multiSelect, or free text). We look up the matching option and return its
 * engine-supplied `tone`. Anything we can't confidently map — no options, no
 * exact single-label match (multiSelect / "Other: …" / free text), or an option
 * without a tone — is `neutral`, so we never guess an affirmative/negative
 * color for an answer we don't understand.
 */
export function resolveAnswerTone(
  answer: string | undefined,
  options: AskUserOption[] | undefined,
): AskUserTone {
  if (answer === undefined || !options || options.length === 0) return "neutral";
  const match = options.find((o) => o.label === answer);
  return normalizeTone(match?.tone);
}

/** Coerce an arbitrary tone-ish value to a known tone (default neutral). */
export function normalizeTone(tone: unknown): AskUserTone {
  return tone === "ok" || tone === "danger" ? tone : "neutral";
}

export interface ToneStyle {
  /** Tailwind classes for the resolved-echo pill / colored text. */
  className: string;
  /** Which icon to show: check (ok), cross (danger), or none (neutral). */
  icon: "check" | "cross" | "none";
}

/** Map a tone to the echo pill's color classes + icon. */
export function toneEchoStyle(tone: AskUserTone): ToneStyle {
  switch (tone) {
    case "ok":
      return { className: "bg-status-ok/10 text-status-ok", icon: "check" };
    case "danger":
      return { className: "bg-status-err/10 text-status-err", icon: "cross" };
    default:
      return { className: "bg-muted text-muted-foreground", icon: "none" };
  }
}
