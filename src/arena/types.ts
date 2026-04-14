/**
 * Arena types — multi-model review, discussion, and planning.
 *
 * V2 architecture: shared facts → independent research → findings → cross-review → consensus.
 */

import type { LLMConfig } from "../types.js";

// ─── Arena Mode ─────────────────────────────────────────────────

/** Arena operating mode — determines prompts, output format, and default rounds */
export type ArenaMode = "review" | "discussion" | "planning";

/** Result of auto-detecting the arena mode from the topic */
export interface ArenaModeDetection {
  mode: ArenaMode;
  confidence: "high" | "low";
  reason: string;
}

/** Default max discussion rounds per mode */
export const ARENA_MODE_DEFAULTS: Record<ArenaMode, { maxDiscussionRounds: number; convergenceThreshold: number }> = {
  review:     { maxDiscussionRounds: 3, convergenceThreshold: 200 },
  discussion: { maxDiscussionRounds: 4, convergenceThreshold: 300 },
  planning:   { maxDiscussionRounds: 5, convergenceThreshold: 400 },
};

// ─── Participants ───────────────────────────────────────────────

/** A participant in the arena (a model instance) */
export interface ArenaParticipant {
  /** Display name, e.g. "Claude Sonnet", "GPT-4o" */
  name: string;
  /** LLM config for this participant */
  llm: LLMConfig;
}

// ─── V2: Intent Resolution ─────────────────────────────────────

/** Target type for arena analysis */
export type ArenaTargetType =
  | "git_worktree"
  | "git_branch_compare"
  | "module_compare"
  | "file_compare"
  | "topic_exploration"
  | "architecture_review";

/** LLM-resolved intent from user topic */
export interface ArenaIntentSpec {
  mode: ArenaMode;
  targetType: ArenaTargetType;
  rawTopic: string;
  targets?: string[];
  baseRef?: string;
  headRef?: string;
  needsGit: boolean;
  confidence: "high" | "medium" | "low";
  followUpQuestion?: string;
}

// ─── V2: Scope Resolution ──────────────────────────────────────

export type ArenaScopeKind = "git" | "module" | "files" | "topic";

export interface ArenaScopeSpec {
  kind: ArenaScopeKind;
  label: string;
  git?: {
    baseRef?: string;
    headRef?: string;
    mergeBase?: string;
    includeWorkingTree?: boolean;
  };
  modules?: string[];
  files?: string[];
  searchHints?: string[];
}

// ─── V2: Base Context (shared facts) ───────────────────────────

export interface ArenaBaseContext {
  scope: ArenaScopeSpec;
  repoSummary?: string;
  gitFacts?: {
    currentBranch?: string;
    baseRef?: string;
    headRef?: string;
    commitLog?: string[];
    diffStat?: string;
    changedFiles?: string[];
  };
  codeFacts: {
    keyFiles: string[];
    fileSummaries: Array<{ path: string; summary: string }>;
    symbolIndex?: Array<{ symbol: string; path: string }>;
  };
  rawArtifacts: Array<{
    kind: "diff" | "file" | "grep" | "tree" | "doc";
    id: string;
    preview: string;
  }>;
}

// ─── V2: Findings ──────────────────────────────────────────────

export type FindingKind = "strength" | "improvement" | "risk" | "question";

export interface ArenaFinding {
  id: string;
  kind: FindingKind;
  title: string;
  summary: string;
  severity?: "high" | "medium" | "low";
  confidence: number;
  evidence: Array<{
    type: "file" | "diff" | "grep" | "git" | "doc";
    ref: string;
    note: string;
  }>;
  affectedFiles: string[];
  suggestedChange?: string;
}

// ─── V2: Participant Research ──────────────────────────────────

export interface ParticipantContextRequest {
  participant: string;
  requests: Array<{
    tool: string;
    reason: string;
    args: Record<string, unknown>;
  }>;
}

export interface ParticipantReport {
  participant: string;
  contextSummary: string;
  findings: ArenaFinding[];
}

// ─── V2: Cross Review ──────────────────────────────────────────

export type PeerVerdict = "agree" | "refine" | "disagree" | "needs_evidence";

export interface FindingReview {
  reviewer: string;
  findingId: string;
  verdict: PeerVerdict;
  reason: string;
  extraEvidence?: string[];
}

// ─── V2: Consensus ─────────────────────────────────────────────

export interface ArenaConsensusItem {
  title: string;
  summary: string;
  support: string[];
  challenge: string[];
  confidence: number;
  evidenceRefs: string[];
}

export interface ArenaConsensus {
  /** Overall assessment */
  summary: string;
  /** What changed — scope, key modules, high-level description of the diff (review mode) */
  changeSummary?: string;
  strengths: ArenaConsensusItem[];
  improvements: ArenaConsensusItem[];
  risks: ArenaConsensusItem[];
  openQuestions: ArenaConsensusItem[];
  nextActions: Array<{
    title: string;
    priority: "high" | "medium" | "low";
    rationale: string;
    relatedFindings: string[];
  }>;
}

// ─── V2: Result ────────────────────────────────────────────────

export interface ArenaResultV2 {
  topic: string;
  mode: ArenaMode;
  participants: string[];
  intent: ArenaIntentSpec;
  scope: ArenaScopeSpec;
  baseContext: ArenaBaseContext;
  reports: ParticipantReport[];
  reviews: FindingReview[];
  consensus: ArenaConsensus;
  totalRounds: number;
}

// ─── Legacy Phase Outputs (kept for transition) ────────────────

/** An initial opinion from one participant (generic across all modes) */
export interface Opinion {
  participant: string;
  opinion: string;
  score?: number;
  issues: string[];
  suggestions: string[];
}

/** Backward-compatible alias */
export type ReviewOpinion = Opinion;

/** A discussion message between participants */
export interface DiscussionMessage {
  participant: string;
  content: string;
  round: number;
  replyTo?: string;
}

/** Final consensus from the arena (review / discussion mode) */
export interface ArenaConclusion {
  summary: string;
  agreed: string[];
  disagreed: string[];
  finalScore?: number;
  recommendation: "approve" | "revise" | "reject";
  actionItems: string[];
}

/** Final output for planning mode */
export interface ArenaPlanConclusion {
  summary: string;
  agreed: string[];
  disagreed: string[];
  roadmap: ArenaPlanItem[];
  risks: string[];
}

/** A single item in a planning roadmap */
export interface ArenaPlanItem {
  title: string;
  priority: "high" | "medium" | "low";
  description: string;
  dependencies?: string[];
}

/** Union conclusion type — the arena returns whichever matches the mode */
export type ArenaConclusionUnion = ArenaConclusion | ArenaPlanConclusion;

/** Type guard: is the conclusion a plan? */
export function isPlanConclusion(c: ArenaConclusionUnion): c is ArenaPlanConclusion {
  return "roadmap" in c;
}

// ─── Strategy ───────────────────────────────────────────────────

/**
 * ArenaStrategy — encapsulates mode-specific behavior for prompts and parsing.
 *
 * V2 strategies produce structured findings instead of free-text opinions.
 */
export interface ArenaStrategy {
  /** Build the system prompt for participant research phase */
  researchSystemPrompt(participantName: string): string;
  /** Build the user prompt for participant research, given base context */
  researchUserPrompt(topic: string, baseContext: ArenaBaseContext): string;
  /** Parse participant research response into structured report */
  parseResearchResponse(participant: string, text: string): ParticipantReport;

  /** Build the system prompt for cross-review phase */
  crossReviewSystemPrompt(reviewerName: string): string;
  /** Build the user prompt for cross-reviewing other participants' findings */
  crossReviewUserPrompt(
    topic: string,
    myReport: ParticipantReport,
    otherReports: ParticipantReport[],
  ): string;
  /** Parse cross-review response into finding reviews */
  parseCrossReviewResponse(reviewer: string, text: string): FindingReview[];

  /** Build the system prompt for consensus building */
  consensusSystemPrompt(): string;
  /** Build the user prompt for consensus building */
  consensusUserPrompt(
    topic: string,
    reports: ParticipantReport[],
    reviews: FindingReview[],
  ): string;
  /** Parse consensus response */
  parseConsensusResponse(text: string): ArenaConsensus;

  /** Finding kinds this mode emphasizes */
  preferredFindingKinds(): FindingKind[];
}

// ─── Config ─────────────────────────────────────────────────────

/** Arena configuration */
export interface ArenaConfig {
  /** Participants (models) in the arena */
  participants: ArenaParticipant[];
  /** Arena mode (default: "review") */
  mode?: ArenaMode;
  /** Maximum discussion rounds after initial opinions (overrides mode default if set) */
  maxDiscussionRounds?: number;
  /** Which participant generates the final conclusion (default: first) */
  concluder?: string;
  /** Optional custom strategy — overrides mode-based strategy selection */
  strategy?: ArenaStrategy;
  /**
   * Enable read-only context tools (read_file, grep_code, list_files) during
   * participant research. Participants can request additional source context.
   */
  enableContextTools?: boolean;
  /** Callback for streaming arena progress */
  onProgress?: (event: ArenaProgressEvent) => void;
}

// ─── Progress Events ────────────────────────────────────────────

export type ArenaProgressEvent =
  | { type: "intent_resolved"; intent: ArenaIntentSpec }
  | { type: "scope_resolved"; scope: ArenaScopeSpec }
  | { type: "facts_collected"; context: ArenaBaseContext }
  | { type: "research_start"; participant: string }
  | { type: "research_done"; participant: string; report: ParticipantReport }
  | { type: "context_lookup"; participant: string; tools: string[] }
  | { type: "cross_review_start"; round: number }
  | { type: "cross_review_done"; reviews: FindingReview[] }
  | { type: "consensus_start" }
  | { type: "consensus_done"; consensus: ArenaConsensus };
