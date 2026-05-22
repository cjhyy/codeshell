/**
 * Arena mode auto-detection — infer review/discussion/planning from topic text.
 *
 * Heuristic-based: uses keyword matching with weighted scoring.
 * Falls back to "review" (safest default) when confidence is low.
 */

import type { ArenaMode } from "./types.js";

/** Result of heuristic mode detection */
export interface ArenaModeDetection {
  mode: ArenaMode;
  confidence: "high" | "low";
  reason: string;
}

// ─── Keyword patterns per mode ──────────────────────────────────

interface ModeSignal {
  /** Regex patterns that suggest this mode */
  patterns: RegExp[];
  /** Weight per match (default 1) */
  weight?: number;
}

const MODE_SIGNALS: Record<ArenaMode, ModeSignal[]> = {
  review: [
    { patterns: [/\breview\b/i, /\baudit\b/i, /\binspect\b/i, /\bcheck\b/i], weight: 2 },
    { patterns: [/\bcode\s*quality\b/i, /\bbug\b/i, /\bvulnerab/i, /\bsecur/i] },
    { patterns: [/\bpr\b/i, /\bpull\s*request\b/i, /\bdiff\b/i, /\bchanges?\b/i] },
    { patterns: [/\brefactor/i, /\bclean\s*up\b/i, /\bimprove\b/i] },
  ],
  discussion: [
    { patterns: [/\bdiscuss\b/i, /\bdebate\b/i, /\bcompare\b/i], weight: 2 },
    { patterns: [/\bpros?\s*(and|&|\/)\s*cons?\b/i, /\btrade\s*-?\s*offs?\b/i] },
    { patterns: [/\bshould\s+we\b/i, /\bwhich\s+(is|approach|way)\b/i, /\bvs\.?\b/i] },
    { patterns: [/\bopinion\b/i, /\bthoughts?\b/i, /\badvice\b/i] },
  ],
  planning: [
    { patterns: [/\bplan\b/i, /\bplanning\b/i, /\broadmap\b/i, /\bstrategy\b/i], weight: 2 },
    { patterns: [/\barchitect/i, /\bdesign\b/i, /\bproposal\b/i] },
    { patterns: [/\bimplement(ation)?\s+(plan|strategy|approach)\b/i], weight: 2 },
    { patterns: [/\bphase\b/i, /\bmilestone\b/i, /\btimeline\b/i, /\bprioritiz/i] },
    { patterns: [/\bbuild\b/i, /\bcreate\b/i, /\bsetup\b/i, /\bbootstrap\b/i] },
  ],
};

/** Confidence threshold: below this → low confidence */
const HIGH_CONFIDENCE_THRESHOLD = 3;
/** Minimum lead over runner-up to be "high" confidence */
const MIN_LEAD = 2;

// ─── Detection ──────────────────────────────────────────────────

/**
 * Auto-detect arena mode from the topic string.
 *
 * Returns the detected mode, confidence level, and a human-readable reason.
 * When confidence is low, falls back to "review" (the safest default).
 */
export function detectArenaMode(topic: string): ArenaModeDetection {
  const scores: Record<ArenaMode, number> = { review: 0, discussion: 0, planning: 0 };

  for (const [mode, signals] of Object.entries(MODE_SIGNALS) as [ArenaMode, ModeSignal[]][]) {
    for (const signal of signals) {
      const weight = signal.weight ?? 1;
      for (const pattern of signal.patterns) {
        if (pattern.test(topic)) {
          scores[mode] += weight;
        }
      }
    }
  }

  // Sort modes by score descending
  const ranked = (Object.entries(scores) as [ArenaMode, number][])
    .sort((a, b) => b[1] - a[1]);

  const [bestMode, bestScore] = ranked[0];
  const [, runnerUpScore] = ranked[1];
  const lead = bestScore - runnerUpScore;

  // Determine confidence
  if (bestScore >= HIGH_CONFIDENCE_THRESHOLD && lead >= MIN_LEAD) {
    return {
      mode: bestMode,
      confidence: "high",
      reason: `Topic strongly matches "${bestMode}" (score: ${bestScore}, lead: +${lead})`,
    };
  }

  if (bestScore > 0 && lead > 0) {
    return {
      mode: bestMode,
      confidence: "low",
      reason: `Topic weakly matches "${bestMode}" (score: ${bestScore}, lead: +${lead})`,
    };
  }

  // No signal at all → default to review
  return {
    mode: "review",
    confidence: "low",
    reason: "No strong mode signal detected, defaulting to review",
  };
}
