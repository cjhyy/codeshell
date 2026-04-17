/**
 * Arena types — multi-model review, discussion, and planning.
 *
 * V2 architecture: shared facts → independent research → findings → cross-review → consensus.
 */

import type { LLMConfig } from "../types.js";

// ─── Arena Mode ─────────────────────────────────────────────────

/** Arena operating mode — determines prompts, output format, and default rounds */
export type ArenaMode = "review" | "discussion" | "planning";

// ─── Evidence-Driven Arena (Lens / Source / Plan) ───────────────

/** Analysis lens — the perspective from which participants analyze */
export type ArenaLensName = "engineering" | "product" | "architecture" | "general";

/** Lens reference with optional weight for multi-lens scenarios */
export interface ArenaLensRef {
  name: ArenaLensName;
  weight?: number;
}

/** A lens defines roles, criteria, and emphasis for a given perspective */
export interface ArenaLens {
  name: ArenaLensName;
  label: string;
  participantRole: string;
  reviewerRole: string;
  moderatorRole: string;
  summaryLabel: string;
  criteria: string[];
  preferredFindingKinds: FindingKind[];
}

/** Evidence source kind — where to collect facts */
export type ArenaSourceKind = "git" | "repo" | "docs" | "web" | "none";

/** Source specification with optional targets and tool pack */
export interface ArenaSourceSpec {
  kind: ArenaSourceKind;
  targets?: string[];
  toolPack?: string;
}

/** Subject of the arena session */
export interface ArenaSubject {
  kind: "changes" | "files" | "docs" | "topic" | "mixed";
  label: string;
  targets?: string[];
}

/** Output shape hints for rendering */
export interface ArenaOutputShape {
  overviewLabel: string;
  emphasize: Array<"strength" | "improvement" | "risk" | "question">;
}

/** The full plan produced by the Planner — drives the entire pipeline */
export interface ArenaPlan {
  mode: ArenaMode;
  lenses: ArenaLensRef[];
  sources: ArenaSourceSpec[];
  subject: ArenaSubject;
  outputShape: ArenaOutputShape;
  confidence: "high" | "medium" | "low";
  followUpQuestion?: string;
}

/** Unified artifact — all providers output this, replacing codeFacts/gitFacts split */
export interface ArenaArtifact {
  id: string;
  kind: "diff" | "file" | "tree" | "grep" | "doc" | "web";
  source: ArenaSourceKind;
  title: string;
  ref?: string;
  preview: string;
  metadata?: Record<string, unknown>;
}

/** Tool pack — a named set of tools available during research */
export interface ArenaToolPack {
  name: string;
  toolNames: string[];
}

/** Context provider interface — collects evidence from a source */
export interface ArenaContextProvider {
  kind: ArenaSourceKind;
  collect(plan: ArenaPlan, topic: string): ArenaArtifact[];
}

/** Quick fact — high-signal summary entry */
export interface ArenaQuickFact {
  label: string;
  value: string;
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

// ─── V2: Base Context ─────────────────────────────────────────

export interface ArenaBaseContext {
  /** Evidence-driven plan that drives the session */
  plan: ArenaPlan;
  /** Unified artifacts from all providers */
  artifacts: ArenaArtifact[];
  /** High-signal summary facts */
  quickFacts: ArenaQuickFact[];
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

// ─── Evidence-Driven: Tool Trace ──────────────────────────────

/** Record of a single tool invocation during research or review */
export interface ToolTrace {
  round: number;
  toolName: string;
  args: Record<string, unknown>;
  resultRef?: string;
  keptAsEvidence?: boolean;
}

// ─── Evidence-Driven: Evidence Packet ─────────────────────────

/** A discrete packet of evidence collected during research or review */
export interface EvidencePacket {
  packetId: string;
  participant: string;
  source: ArenaSourceKind;
  title: string;
  refs: string[];
  summary: string;
  excerpts: Array<{
    ref: string;
    snippet: string;
    note: string;
  }>;
}

// ─── Evidence-Driven: Research Dossier ────────────────────────

/** Explicit link between a finding and its supporting evidence packets */
export interface FindingEvidenceLink {
  findingId: string;
  evidencePacketIds: string[];
}

/** Full research output — preserves evidence trail alongside findings */
export interface ResearchDossier {
  participant: string;
  contextSummary: string;
  findings: ArenaFinding[];
  toolTrace: ToolTrace[];
  evidencePackets: EvidencePacket[];
  findingEvidenceLinks: FindingEvidenceLink[];
}

// ─── Peer Verdict (used by both Cross Review and Claim System) ─

export type PeerVerdict = "agree" | "refine" | "disagree" | "needs_evidence";

// ─── Evidence-Driven: Claim System ────────────────────────────

export type ClaimStatus =
  | "proposed"
  | "under_review"
  | "contested"
  | "verified"
  | "rejected"
  | "unresolved";

export interface RequestedCheck {
  requestId: string;
  claimId: string;
  requester: string;
  description: string;
  refs?: string[];
  priority?: "high" | "medium" | "low";
}

export interface ClaimChallenge {
  reviewer: string;
  claimId: string;
  verdict: PeerVerdict;
  reason: string;
  supportingEvidenceRefs?: string[];
  requestedChecks?: RequestedCheck[];
}

export interface DebateTurn {
  participant: string;
  stance: "support" | "oppose" | "narrow" | "uncertain";
  summary: string;
  newEvidenceRefs?: string[];
}

export interface DebateRound {
  round: number;
  claimId: string;
  participants: DebateTurn[];
  resolved: boolean;
  resolutionNote?: string;
}

export interface ClaimAdjudication {
  claimId: string;
  outcome: "accepted" | "accepted_with_revision" | "rejected" | "unresolved";
  rationale: string;
  finalSummary: string;
  supportingEvidenceRefs: string[];
}

/** The minimum unit of debate — a finding elevated to a trackable claim */
export interface ClaimRecord {
  claimId: string;
  owner: string;
  finding: ArenaFinding;
  evidenceRefs: string[];
  evidencePacketIds: string[];
  status: ClaimStatus;
  challenges: ClaimChallenge[];
  debateRounds: DebateRound[];
  adjudication?: ClaimAdjudication;
}

// ─── Evidence-Driven: Shared Research Ledger ──────────────────

/** Append-only shared state across all rounds of research, review, debate */
export interface SharedResearchLedger {
  dossiers: ResearchDossier[];
  evidencePackets: EvidencePacket[];
  toolTraces: ToolTrace[];
  claims: ClaimRecord[];
  challenges: ClaimChallenge[];
  requestedChecks: RequestedCheck[];
  adjudications: ClaimAdjudication[];
}

/** Per-round digest — a filtered view of the ledger for prompt injection */
export interface RoundResearchDigest {
  round: number;
  relevantClaimIds: string[];
  evidencePackets: EvidencePacket[];
  toolTraceSummary: Array<{
    participant: string;
    toolName: string;
    ref?: string;
  }>;
  recentChallenges: ClaimChallenge[];
  requestedChecks: RequestedCheck[];
  priorAdjudications: ClaimAdjudication[];
}

/** Task for executing a targeted re-research check */
export interface TargetedCheckTask {
  request: RequestedCheck;
  assignee: string;
  status: "pending" | "running" | "done" | "skipped";
  producedPacketIds: string[];
}

// ─── Evidence-Driven: Execution Limits ────────────────────────

/** Global caps to prevent cost explosion in review/debate phases */
export interface ArenaExecutionLimits {
  maxClaimsForReview: number;
  maxContestedClaimsForDebate: number;
  maxRequestedChecksPerClaimPerRound: number;
  maxReviewersPerClaim: number;
  /** Max roadmap phases in planning mode */
  maxRoadmapPhases: number;
  /** Max phases to expand with detail in planning mode */
  maxExpandedPhasesPerRun: number;
}

export const DEFAULT_EXECUTION_LIMITS: ArenaExecutionLimits = {
  maxClaimsForReview: 12,
  maxContestedClaimsForDebate: 5,
  maxRequestedChecksPerClaimPerRound: 2,
  maxReviewersPerClaim: 2,
  maxRoadmapPhases: 6,
  maxExpandedPhasesPerRun: 6,
};

// ─── V2: Cross Review ──────────────────────────────────────────

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

export interface ArenaRoadmapPhase {
  title: string;
  priority: "high" | "medium" | "low";
  goal: string;
  scope: string[];
  deliverables: string[];
  dependencies: string[];
  risks: string[];
  successCriteria: string[];
  relatedFindings: string[];
}

/** Repo-level implementation detail for a roadmap phase (planning mode) */
export interface ArenaRoadmapPhaseDetail {
  phaseTitle: string;
  objective: string;
  targetFiles: string[];
  codeChanges: string[];
  interfaces: string[];
  migrationSteps: string[];
  validation: string[];
  effort: "small" | "medium" | "large";
  blockers: string[];
  evidenceRefs: string[];
}

export interface ArenaConsensus {
  /** Overall assessment */
  summary: string;
  /** Subject summary — rendered as "What Changed" / "Current Scope" / "Problem Framing" per mode */
  subjectSummary?: string;
  strengths: ArenaConsensusItem[];
  improvements: ArenaConsensusItem[];
  risks: ArenaConsensusItem[];
  openQuestions: ArenaConsensusItem[];
  roadmap: ArenaRoadmapPhase[];
  /** Repo-level implementation details per roadmap phase (planning mode) */
  roadmapDetails?: ArenaRoadmapPhaseDetail[];
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
  plan: ArenaPlan;
  baseContext: ArenaBaseContext;
  reports: ParticipantReport[];
  /** Research dossiers with evidence trails (Phase 3+) */
  dossiers?: ResearchDossier[];
  /** Registered claims derived from findings (Phase 3+) */
  claims?: ClaimRecord[];
  reviews: FindingReview[];
  /** Debate rounds for contested claims (Phase 3+) */
  debateRounds?: DebateRound[];
  /** Claim adjudications (Phase 3+) */
  adjudications?: ClaimAdjudication[];
  consensus: ArenaConsensus;
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

/**
 * ArenaStrategyV2 — extends ArenaStrategy with claim-aware prompt methods.
 *
 * Strategies implementing V2 participate in the full evidence-driven loop:
 * verification review, debate, adjudication, and claim-aware consensus.
 *
 * Strategies that only implement ArenaStrategy continue to work via
 * automatic fallback paths in each phase.
 */
export interface ArenaStrategyV2 extends ArenaStrategy {
  /** Build verification-review user prompt with claim data and digest */
  verificationReviewUserPrompt(
    topic: string,
    myReport: ParticipantReport,
    claimsToReview: ClaimRecord[],
    digest: RoundResearchDigest,
  ): string;

  /** Parse verification review into ClaimChallenge records */
  parseVerificationReviewResponse(reviewer: string, text: string): ClaimChallenge[];

  /** Build debate turn prompt for a participant on a specific claim */
  debateTurnUserPrompt(
    topic: string,
    claim: ClaimRecord,
    priorTurns: DebateTurn[],
    digest: RoundResearchDigest,
  ): string;

  /** Parse a debate turn response */
  parseDebateTurnResponse(participant: string, text: string): DebateTurn;

  /** Build adjudication prompt for the moderator */
  adjudicationUserPrompt(
    topic: string,
    claim: ClaimRecord,
    debateRounds: DebateRound[],
    digest: RoundResearchDigest,
  ): string;

  /** Parse adjudication response */
  parseAdjudicationResponse(text: string): ClaimAdjudication;

  /** Build claim-aware consensus prompt */
  claimAwareConsensusUserPrompt(
    topic: string,
    reports: ParticipantReport[],
    reviews: FindingReview[],
    claimSummary: ClaimStatusSummary,
  ): string;
}

/**
 * ArenaStrategyPlanning — extends ArenaStrategyV2 with planning-specific methods.
 *
 * Strategies implementing this participate in the planning-specific flow:
 * merge-oriented review and detail expansion.
 */
export interface ArenaStrategyPlanning extends ArenaStrategyV2 {
  /** Build merge-oriented review prompt for planning mode */
  mergeReviewUserPrompt(
    topic: string,
    myReport: ParticipantReport,
    claimsToReview: ClaimRecord[],
    digest: RoundResearchDigest,
  ): string;

  /** Parse merge-review response into challenges with planning semantics */
  parseMergeReviewResponse(reviewer: string, text: string): ClaimChallenge[];

  /** Build detail expansion system prompt */
  detailExpansionSystemPrompt(): string;

  /** Build detail expansion user prompt for a single roadmap phase */
  detailExpansionUserPrompt(
    topic: string,
    phase: ArenaRoadmapPhase,
    digest: RoundResearchDigest,
  ): string;

  /** Parse detail expansion response */
  parseDetailExpansionResponse(text: string): ArenaRoadmapPhaseDetail;
}

/** Type guard: does a strategy implement ArenaStrategyPlanning? */
export function isStrategyPlanning(s: ArenaStrategy): s is ArenaStrategyPlanning {
  return typeof (s as ArenaStrategyPlanning).detailExpansionUserPrompt === "function";
}

/** Grouped claims by terminal status — used in claim-aware consensus */
export interface ClaimStatusSummary {
  verified: ClaimRecord[];
  contested: ClaimRecord[];
  unresolved: ClaimRecord[];
  rejected: ClaimRecord[];
}

/** Type guard: does a strategy implement ArenaStrategyV2? */
export function isStrategyV2(s: ArenaStrategy): s is ArenaStrategyV2 {
  return typeof (s as ArenaStrategyV2).verificationReviewUserPrompt === "function";
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
  /** Execution limits for review/debate/adjudication phases */
  executionLimits?: ArenaExecutionLimits;
  /** Callback for streaming arena progress */
  onProgress?: (event: ArenaProgressEvent) => void;
  /** AbortSignal for cancelling a running arena session */
  signal?: AbortSignal;
}

// ─── Progress Events ────────────────────────────────────────────

export type ArenaProgressEvent =
  | { type: "plan_resolved"; plan: ArenaPlan }
  | { type: "evidence_collected"; artifacts: ArenaArtifact[] }
  | { type: "research_start"; participant: string }
  | { type: "research_done"; participant: string; report: ParticipantReport }
  | { type: "context_lookup"; participant: string; tools: string[] }
  | { type: "claims_registered"; claimCount: number }
  | { type: "cross_review_start"; round: number }
  | { type: "cross_review_done"; reviews: FindingReview[] }
  | { type: "verification_start" }
  | { type: "verification_done"; challengeCount: number }
  | { type: "debate_round_start"; round: number; claims: string[] }
  | { type: "debate_round_done"; round: number; resolved: number }
  | { type: "adjudication_done"; accepted: number; unresolved: number }
  | { type: "planning_merge_review_start" }
  | { type: "planning_merge_review_done"; mergeCount: number }
  | { type: "roadmap_expansion_start"; phaseCount: number }
  | { type: "roadmap_expansion_done"; detailCount: number }
  | { type: "consensus_start" }
  | { type: "consensus_done"; consensus: ArenaConsensus };
