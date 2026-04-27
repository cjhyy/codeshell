/**
 * Iterate mode — multi-model authoring loop.
 *
 * Author writes → critics argue → author revises → ... → final draft.
 * v1 uses a tournament: every participant writes a candidate, then the
 * author merges (anonymized inputs) into a single v1.
 */

import type { ArenaParticipant } from "../types.js";

// ─── Subject ────────────────────────────────────────────────────

export type IterateFormat = "code" | "document";

export interface IterateSubject {
  /** What the author is producing — short descriptive label. */
  label: string;
  /** Full instruction to the author / critics. */
  description: string;
  /** Optional source artifacts (file paths, urls) to ground the work. */
  sources?: string[];
}

// ─── Draft ──────────────────────────────────────────────────────

/** A v1 candidate produced by one participant during the tournament. */
export interface DraftCandidate {
  author: string;            // participant name (real)
  anonymousLabel: string;    // "Draft A", "Draft B", ... — what merger sees
  content: string;
}

export interface Draft {
  version: number;           // 1, 2, 3, ...
  author: string;            // who wrote/merged this version
  format: IterateFormat;
  content: string;
  /**
   * For v1 with tournament strategy: the candidates that were merged.
   * For v2+: undefined.
   */
  draftCandidates?: DraftCandidate[];
  /** Author's explanation of how candidates were merged into v1. */
  mergeRationale?: string;
  /**
   * For v2+: which critique IDs were addressed and how.
   */
  acceptedCritiques?: string[];
  rejectedCritiques?: Array<{ id: string; reason: string }>;
  /** Free-form note from author: what changed and why. */
  changelog?: string;
}

// ─── Critique ───────────────────────────────────────────────────

export type CritiqueSeverity = "blocker" | "major" | "minor" | "nit" | "praise";
export type CritiqueCategory =
  | "correctness"
  | "completeness"
  | "clarity"
  | "evidence"
  | "structure"
  | "style"
  | "other";

export interface Critique {
  id: string;
  critic: string;            // participant name
  /** 5-15 word quote from the draft for precise location. */
  anchor: string;
  severity: CritiqueSeverity;
  category: CritiqueCategory;
  comment: string;
  /** Optional concrete suggestion. */
  suggestion?: string;
}

// ─── Round ──────────────────────────────────────────────────────

export interface ConvergenceSignal {
  blockerCount: number;
  majorCount: number;
  totalCritiques: number;
  /** Levenshtein-ratio-like 0..1, where 0 = identical, 1 = totally different. */
  diffFromPrevious: number;
  shouldStop: boolean;
  reason: "blockers_zero_and_stable" | "all_minor_or_praise" | "max_rounds" | "user_stop" | "user_force_continue" | "diff_below_threshold" | "running";
}

export interface Round {
  round: number;
  draft: Draft;
  critiques: Critique[];
  convergence: ConvergenceSignal;
}

// ─── Config & Result ────────────────────────────────────────────

export type AuthorRotation = "fixed" | "round-robin" | "best-critic";

export interface CheckpointContext {
  round: number;
  draft: Draft;
  critiques: Critique[];
  convergence: ConvergenceSignal;
}

export type CheckpointAction = "continue" | "stop" | "force-continue";
export type CheckpointFn = (ctx: CheckpointContext) => Promise<CheckpointAction>;

export interface IterateProgressEvent {
  type:
    | "v1_tournament_start"
    | "v1_candidate_done"
    | "v1_merge_start"
    | "v1_merge_done"
    | "round_start"
    | "argue_start"
    | "argue_done"
    | "revise_start"
    | "revise_done"
    | "round_done"
    | "checkpoint_pause"
    | "iterate_complete";
  round?: number;
  participant?: string;
  data?: Record<string, unknown>;
}

export interface IterateConfig {
  subject: IterateSubject;
  format: IterateFormat;
  /** The participant who merges v1 and main-authors v2+. Required. */
  author: ArenaParticipant;
  /** Critic participants. Each must have unique `name`. */
  critics: ArenaParticipant[];

  /** Default 5. */
  maxRounds?: number;

  /**
   * v1 strategy.
   * - "tournament" (default): author + all critics each write a candidate,
   *    author merges anonymized candidates into v1.
   * - "single": author writes v1 alone (no tournament).
   */
  v1Strategy?: "tournament" | "single";

  /** Default "fixed". */
  authorRotation?: AuthorRotation;

  /**
   * If provided, called after each round; arena pauses for the response.
   * Default: undefined (no checkpoints).
   */
  humanCheckpoint?: CheckpointFn;

  /**
   * Convergence rules. "default" applies built-in heuristics.
   * Custom function returns true → stop after this round.
   */
  convergenceStrategy?: "default" | ((ctx: { round: number; critiques: Critique[]; draft: Draft; previousDraft?: Draft }) => boolean);

  /** Minimum content length per draft (chars). Used both as length budget hint and to retry-on-shrinkage. Default 800 for document, 200 for code. */
  minDraftLength?: number;

  signal?: AbortSignal;
  onProgress?: (event: IterateProgressEvent) => void;
}

export type StoppedReason = "converged" | "max_rounds" | "user_stop" | "errored" | "aborted";

export interface IterateResult {
  subject: IterateSubject;
  format: IterateFormat;
  rounds: Round[];
  finalDraft: Draft;
  stoppedAt: StoppedReason;
  durationMs: number;
}
