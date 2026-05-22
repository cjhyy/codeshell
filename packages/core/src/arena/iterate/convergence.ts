/**
 * Convergence detection — when has the draft stabilized enough to stop?
 */

import type { ConvergenceSignal, Critique, Draft } from "./types.js";

/**
 * Cheap O(n) approximation of "how different is new vs old".
 * Returns 0..1 where 0 = identical, 1 = completely different.
 *
 * Uses character-trigram Jaccard distance — fast, good enough for "is the
 * author actually changing anything substantial?".
 */
export function diffRatio(a: string, b: string): number {
  if (a === b) return 0;
  if (!a || !b) return 1;
  const trigrams = (s: string) => {
    const out = new Set<string>();
    for (let i = 0; i < s.length - 2; i++) out.add(s.slice(i, i + 3));
    return out;
  };
  const A = trigrams(a);
  const B = trigrams(b);
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  const union = A.size + B.size - inter;
  if (union === 0) return 0;
  const jaccard = inter / union; // similarity
  return 1 - jaccard;
}

/**
 * Default convergence rule:
 *   stop if blockers == 0 AND
 *     (all critiques are minor/nit/praise OR diff < 5% from last version)
 *
 * Round 1 never converges (need at least one revision pass).
 */
export function defaultConvergence(args: {
  round: number;
  critiques: Critique[];
  draft: Draft;
  previousDraft?: Draft;
}): ConvergenceSignal {
  const { round, critiques, draft, previousDraft } = args;

  const blockerCount = critiques.filter((c) => c.severity === "blocker").length;
  const majorCount = critiques.filter((c) => c.severity === "major").length;
  const totalCritiques = critiques.length;
  const diffFromPrevious = previousDraft ? diffRatio(previousDraft.content, draft.content) : 1;

  // Round 1 (the v1) — always do at least one revision pass, never converge here.
  if (round === 1) {
    return {
      blockerCount,
      majorCount,
      totalCritiques,
      diffFromPrevious,
      shouldStop: false,
      reason: "running",
    };
  }

  // Special case: zero critiques is almost always a parsing/timeout failure
  // on the critic side, NOT a sign of convergence. Treat as "running" so
  // the next round has a chance — the loop will naturally stop at maxRounds.
  if (totalCritiques === 0) {
    return {
      blockerCount,
      majorCount,
      totalCritiques,
      diffFromPrevious,
      shouldStop: false,
      reason: "running",
    };
  }

  // Hard floor: no blockers AND no majors → all that's left is polish.
  // Require at least 3 critiques so a single low-effort response can't
  // declare false convergence.
  if (blockerCount === 0 && majorCount === 0 && totalCritiques >= 3) {
    return {
      blockerCount,
      majorCount,
      totalCritiques,
      diffFromPrevious,
      shouldStop: true,
      reason: "all_minor_or_praise",
    };
  }

  // Soft floor: no blockers AND draft barely moved → author is stuck or done.
  if (blockerCount === 0 && diffFromPrevious < 0.05) {
    return {
      blockerCount,
      majorCount,
      totalCritiques,
      diffFromPrevious,
      shouldStop: true,
      reason: "blockers_zero_and_stable",
    };
  }

  return {
    blockerCount,
    majorCount,
    totalCritiques,
    diffFromPrevious,
    shouldStop: false,
    reason: "running",
  };
}
