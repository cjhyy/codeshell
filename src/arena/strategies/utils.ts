/** Shared utilities for arena strategy implementations. */

import type {
  ArenaBaseContext,
  ArenaFinding,
  FindingReview,
  ParticipantReport,
  ArenaConsensus,
  ArenaConsensusItem,
  ArenaRoadmapPhase,
  ArenaRoadmapPhaseDetail,
  PeerVerdict,
  FindingKind,
  ClaimRecord,
  ClaimChallenge,
  ClaimAdjudication,
  ClaimStatusSummary,
  DebateTurn,
  RoundResearchDigest,
} from "../types.js";
import { logger } from "../../logging/logger.js";

/** Extract JSON from text that might have markdown fences or surrounding text */
export function extractJSON(text: string): string {
  // Try fenced code blocks — use GREEDY match to handle nested backticks
  const fenced = text.match(/```(?:json)?\s*\n([\s\S]*)\n\s*```/);
  if (fenced) return fenced[1].trim();

  // Try to find the outermost { ... } pair with balanced braces
  const start = text.indexOf("{");
  if (start !== -1) {
    let depth = 0;
    let inString = false;
    let escape = false;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (escape) { escape = false; continue; }
      if (ch === "\\") { escape = true; continue; }
      if (ch === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) return text.slice(start, i + 1);
      }
    }
    // Unbalanced — return from start to end as best effort
    return text.slice(start);
  }

  return text;
}

/** Extract a JSON array from text */
export function extractJSONArray(text: string): string {
  const fenced = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (fenced) return fenced[1].trim();

  const arrayMatch = text.match(/\[[\s\S]*\]/);
  if (arrayMatch) return arrayMatch[0];

  return text;
}

/** Format base context into a readable text block for LLM prompts */
export function formatBaseContext(ctx: ArenaBaseContext): string {
  const sections: string[] = [];

  // Quick facts
  if (ctx.quickFacts.length > 0) {
    sections.push(`## Quick Facts\n${ctx.quickFacts.map((f) => `- ${f.label}: ${f.value}`).join("\n")}`);
  }

  // Artifacts
  for (const artifact of ctx.artifacts) {
    const header = artifact.ref ? `${artifact.title} (${artifact.ref})` : artifact.title;
    sections.push(`## ${artifact.kind.toUpperCase()}: ${header}\n\`\`\`\n${artifact.preview}\n\`\`\``);
  }

  return sections.join("\n\n");
}

/** Format participant reports for cross-review or consensus prompts */
export function formatReports(reports: ParticipantReport[]): string {
  return reports.map((r) => {
    const findingsList = r.findings.map((f) =>
      `  - [${f.id}] (${f.kind}${f.severity ? `, ${f.severity}` : ""}) ${f.title}\n` +
      `    ${f.summary}\n` +
      `    Evidence: ${f.evidence.map((e) => `${e.type}:${e.ref}`).join(", ")}\n` +
      `    Confidence: ${f.confidence}` +
      (f.suggestedChange ? `\n    Suggested: ${f.suggestedChange}` : "")
    ).join("\n");

    return `### ${r.participant}\n${r.contextSummary}\n\nFindings:\n${findingsList}`;
  }).join("\n\n");
}

/** Format finding reviews for consensus prompts */
export function formatFindingReviews(reviews: FindingReview[]): string {
  if (reviews.length === 0) return "No peer reviews.";
  return reviews.map((r) =>
    `[${r.reviewer}] on ${r.findingId}: ${r.verdict}${r.reason ? ` — ${r.reason}` : ""}`
  ).join("\n");
}

/** Parse a ParticipantReport from LLM JSON output */
export function parseReport(participant: string, text: string): ParticipantReport {
  if (!text || text.trim().length === 0) {
    logger.warn("arena.parse_report_empty", { participant });
    return {
      participant,
      contextSummary: "(no response)",
      findings: [],
    };
  }

  try {
    const json = extractJSON(text);
    const parsed = JSON.parse(json);

    // Handle case where LLM wrapped findings in unexpected structure
    let findings = parsed.findings;
    if (!Array.isArray(findings) && parsed.contextSummary === undefined) {
      // Maybe the entire response IS a single finding object
      if (parsed.kind && parsed.title) {
        findings = [parsed];
      }
    }

    const report: ParticipantReport = {
      participant,
      contextSummary: parsed.contextSummary ?? parsed.context_summary ?? "",
      findings: Array.isArray(findings) ? findings.map(parseFinding) : [],
    };

    if (report.findings.length === 0) {
      logger.warn("arena.parse_report_no_findings", {
        participant,
        textPreview: text.slice(0, 200),
      });
    }

    return report;
  } catch (err) {
    logger.warn("arena.parse_report_json_fail", {
      participant,
      error: (err as Error).message,
      textLength: text.length,
      text: text.slice(0, 2000),
    });

    // Fallback: split free-text into paragraph-based findings
    return extractFindingsFromFreeText(participant, text);
  }
}

function parseFinding(raw: any, index: number): ArenaFinding {
  return {
    id: raw.id ?? `f${index + 1}`,
    kind: validateFindingKind(raw.kind),
    title: raw.title ?? "Untitled",
    summary: raw.summary ?? "",
    severity: raw.severity || undefined,
    confidence: typeof raw.confidence === "number" ? raw.confidence : 0.5,
    evidence: Array.isArray(raw.evidence)
      ? raw.evidence.map((e: any) => ({
          type: e.type ?? "doc",
          ref: e.ref ?? "",
          note: e.note ?? "",
        }))
      : [],
    affectedFiles: Array.isArray(raw.affectedFiles) ? raw.affectedFiles : [],
    suggestedChange: raw.suggestedChange || undefined,
  };
}

function validateFindingKind(v: unknown): FindingKind {
  if (v === "strength" || v === "improvement" || v === "risk" || v === "question") return v;
  return "improvement";
}

/**
 * When JSON parsing fails, extract findings from free-text response.
 * Splits by paragraphs/sections and classifies each by keyword heuristics.
 */
function extractFindingsFromFreeText(participant: string, text: string): ParticipantReport {
  // Split into meaningful sections (by headers, numbered lists, or double newlines)
  const sections = text
    .split(/(?:^|\n)(?:#{1,3}\s+|\d+\.\s+|\*\*[^*]+\*\*\s*\n|---+\s*\n)/m)
    .map((s) => s.trim())
    .filter((s) => s.length > 20);

  if (sections.length === 0) {
    // No structure found — use full text as one finding
    return {
      participant,
      contextSummary: text.slice(0, 200),
      findings: [{
        id: `${participant}-f1`,
        kind: "improvement",
        title: "Analysis",
        summary: text.slice(0, 3000),
        confidence: 0.5,
        evidence: [],
        affectedFiles: [],
      }],
    };
  }

  const findings: ArenaFinding[] = sections.slice(0, 10).map((section, i) => {
    // Extract a title from the first line
    const firstLine = section.split("\n")[0].slice(0, 100);
    const body = section.length > firstLine.length
      ? section.slice(firstLine.length).trim()
      : section;

    return {
      id: `${participant}-f${i + 1}`,
      kind: classifyFindingKind(section),
      title: firstLine.replace(/^[-*•]\s*/, "").replace(/\*\*/g, ""),
      summary: body.slice(0, 1000),
      confidence: 0.5,
      evidence: [],
      affectedFiles: extractFilePaths(section),
    };
  });

  return {
    participant,
    contextSummary: text.slice(0, 200),
    findings,
  };
}

/** Classify a free-text paragraph into a finding kind by keywords */
function classifyFindingKind(text: string): FindingKind {
  const lower = text.toLowerCase();
  if (/\b(risk|danger|vulnerab|security|breaking|regression|critical)\b/.test(lower)) return "risk";
  if (/\b(good|well|strength|clean|solid|nice|excellent|properly)\b/.test(lower)) return "strength";
  if (/\b(question|unclear|confirm|clarif|why|how come|wonder)\b/.test(lower)) return "question";
  return "improvement";
}

/** Extract file paths from text (e.g. src/foo/bar.ts) */
function extractFilePaths(text: string): string[] {
  const matches = text.match(/(?:^|\s)((?:src|lib|packages|app)\/[\w\-/.]+\.\w+)/gm);
  return matches ? [...new Set(matches.map((m) => m.trim()))] : [];
}

/** Parse FindingReview[] from LLM JSON output */
export function parseReviews(reviewer: string, text: string): FindingReview[] {
  try {
    const json = extractJSONArray(text);
    const parsed = JSON.parse(json);
    if (!Array.isArray(parsed)) {
      // Maybe it's wrapped in an object
      const objJson = extractJSON(text);
      const obj = JSON.parse(objJson);
      if (Array.isArray(obj.reviews)) {
        return obj.reviews.map((r: any) => parseReview(reviewer, r));
      }
      return [];
    }
    return parsed.map((r: any) => parseReview(reviewer, r));
  } catch {
    return [];
  }
}

function parseReview(reviewer: string, raw: any): FindingReview {
  return {
    reviewer,
    findingId: raw.findingId ?? raw.finding_id ?? "",
    verdict: validateVerdict(raw.verdict),
    reason: raw.reason ?? "",
    extraEvidence: Array.isArray(raw.extraEvidence) ? raw.extraEvidence : undefined,
  };
}

function validateVerdict(v: unknown): PeerVerdict {
  if (v === "agree" || v === "refine" || v === "disagree" || v === "needs_evidence") return v;
  return "agree";
}

/** Parse ArenaConsensus from LLM JSON output */
export function parseConsensus(text: string): ArenaConsensus {
  try {
    const json = extractJSON(text);
    const parsed = JSON.parse(json);
    return {
      summary: parsed.summary ?? "",
      subjectSummary: parsed.subjectSummary || parsed.changeSummary || undefined,
      strengths: parseConsensusItems(parsed.strengths),
      improvements: parseConsensusItems(parsed.improvements),
      risks: parseConsensusItems(parsed.risks),
      openQuestions: parseConsensusItems(parsed.openQuestions),
      roadmap: parseRoadmapPhases(parsed.roadmap),
      nextActions: Array.isArray(parsed.nextActions)
        ? parsed.nextActions.map((a: any) => ({
            title: a.title ?? "",
            priority: validatePriority(a.priority),
            rationale: a.rationale ?? "",
            relatedFindings: Array.isArray(a.relatedFindings) ? a.relatedFindings : [],
          }))
        : [],
    };
  } catch {
    return {
      summary: text,
      strengths: [],
      improvements: [],
      risks: [],
      openQuestions: [],
      roadmap: [],
      nextActions: [],
    };
  }
}

function parseConsensusItems(arr: unknown): ArenaConsensusItem[] {
  if (!Array.isArray(arr)) return [];
  return arr.map((item: any) => ({
    title: item.title ?? "",
    summary: item.summary ?? "",
    support: Array.isArray(item.support) ? item.support : [],
    challenge: Array.isArray(item.challenge) ? item.challenge : [],
    confidence: typeof item.confidence === "number" ? item.confidence : 0.5,
    evidenceRefs: Array.isArray(item.evidenceRefs) ? item.evidenceRefs : [],
  }));
}

function parseRoadmapPhases(arr: unknown): ArenaRoadmapPhase[] {
  if (!Array.isArray(arr)) return [];
  return arr.map((phase: any) => ({
    title: phase.title ?? "",
    priority: validatePriority(phase.priority),
    goal: phase.goal ?? phase.description ?? "",
    scope: toStringArray(phase.scope),
    deliverables: toStringArray(phase.deliverables),
    dependencies: toStringArray(phase.dependencies),
    risks: toStringArray(phase.risks),
    successCriteria: toStringArray(phase.successCriteria),
    relatedFindings: toStringArray(phase.relatedFindings),
  }));
}

function validatePriority(value: unknown): "high" | "medium" | "low" {
  if (value === "high" || value === "medium" || value === "low") return value;
  return "medium";
}

function toStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

// ─── V2: Claim-Aware Formatters ─────────────────────────────────

/** Format claims for verification-review prompts */
export function formatClaimsForReview(claims: ClaimRecord[]): string {
  if (claims.length === 0) return "No claims to review.";
  return claims.map((c) => {
    const f = c.finding;
    const evidence = c.evidenceRefs.length > 0
      ? `\n    Evidence: ${c.evidenceRefs.join(", ")}`
      : "";
    const packets = c.evidencePacketIds.length > 0
      ? `\n    Evidence packets: ${c.evidencePacketIds.join(", ")}`
      : "";
    return (
      `- [${c.claimId}] (${f.kind}${f.severity ? `, ${f.severity}` : ""}, status: ${c.status})\n` +
      `    ${f.title}\n` +
      `    ${f.summary}` +
      evidence +
      packets +
      `\n    Confidence: ${f.confidence}`
    );
  }).join("\n\n");
}

/** Format debate history for debate turn prompts */
export function formatDebateHistory(turns: DebateTurn[]): string {
  if (turns.length === 0) return "No prior debate turns.";
  return turns.map((t) =>
    `[${t.participant}] stance: ${t.stance}\n  ${t.summary}` +
    (t.newEvidenceRefs?.length ? `\n  New evidence: ${t.newEvidenceRefs.join(", ")}` : "")
  ).join("\n");
}

/** Format claim status summary for consensus prompts */
export function formatClaimSummaryForConsensus(summary: ClaimStatusSummary): string {
  const sections: string[] = [];

  if (summary.verified.length > 0) {
    sections.push(
      `### Verified Claims (${summary.verified.length})\n` +
      summary.verified.map((c) =>
        `- [${c.claimId}] ${c.finding.title} (${c.finding.kind}, confidence: ${c.finding.confidence})`
      ).join("\n")
    );
  }

  if (summary.unresolved.length > 0) {
    sections.push(
      `### Unresolved Claims (${summary.unresolved.length})\n` +
      summary.unresolved.map((c) =>
        `- [${c.claimId}] ${c.finding.title} — ${c.challenges.length} challenge(s), no consensus reached`
      ).join("\n")
    );
  }

  if (summary.contested.length > 0) {
    sections.push(
      `### Still Contested (${summary.contested.length})\n` +
      summary.contested.map((c) =>
        `- [${c.claimId}] ${c.finding.title} — ${c.challenges.length} challenge(s)`
      ).join("\n")
    );
  }

  if (summary.rejected.length > 0) {
    sections.push(
      `### Rejected Claims (${summary.rejected.length})\n` +
      summary.rejected.map((c) =>
        `- [${c.claimId}] ${c.finding.title} — rejected: ${c.adjudication?.rationale ?? "no rationale"}`
      ).join("\n")
    );
  }

  return sections.length > 0 ? sections.join("\n\n") : "No claims processed.";
}

/** Format a digest text block for inclusion in prompts */
export function formatDigestForPrompt(digest: RoundResearchDigest): string {
  const sections: string[] = [];
  sections.push(`Claims under review: ${digest.relevantClaimIds.join(", ")}`);

  if (digest.evidencePackets.length > 0) {
    sections.push("\nEvidence:");
    for (const p of digest.evidencePackets) {
      sections.push(`  [${p.packetId}] ${p.title} (${p.source}): ${p.summary}`);
      for (const e of p.excerpts.slice(0, 2)) {
        sections.push(`    > ${e.ref}: ${e.snippet}`);
      }
    }
  }

  if (digest.recentChallenges.length > 0) {
    sections.push("\nPrior challenges:");
    for (const c of digest.recentChallenges) {
      sections.push(`  [${c.reviewer}] on ${c.claimId}: ${c.verdict} — ${c.reason}`);
    }
  }

  return sections.join("\n");
}

// ─── V2: Claim-Aware Parsers ────────────────────────────────────

/** Parse ClaimChallenge[] from LLM JSON output */
export function parseChallenges(reviewer: string, text: string): ClaimChallenge[] {
  try {
    const json = extractJSONArray(text);
    const parsed = JSON.parse(json);
    if (!Array.isArray(parsed)) {
      const objJson = extractJSON(text);
      const obj = JSON.parse(objJson);
      if (Array.isArray(obj.challenges)) {
        return obj.challenges.map((r: any) => parseChallenge(reviewer, r));
      }
      return [];
    }
    return parsed.map((r: any) => parseChallenge(reviewer, r));
  } catch {
    return [];
  }
}

function parseChallenge(reviewer: string, raw: any): ClaimChallenge {
  return {
    reviewer,
    claimId: raw.claimId ?? raw.claim_id ?? "",
    verdict: validateVerdict(raw.verdict),
    reason: raw.reason ?? "",
    supportingEvidenceRefs: Array.isArray(raw.supportingEvidenceRefs)
      ? raw.supportingEvidenceRefs
      : undefined,
    requestedChecks: Array.isArray(raw.requestedChecks)
      ? raw.requestedChecks.map((rc: any) => ({
          requestId: rc.requestId ?? `req-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          claimId: raw.claimId ?? raw.claim_id ?? "",
          requester: reviewer,
          description: rc.description ?? "",
          refs: Array.isArray(rc.refs) ? rc.refs : undefined,
          priority: validateCheckPriority(rc.priority),
        }))
      : undefined,
  };
}

function validateCheckPriority(v: unknown): "high" | "medium" | "low" | undefined {
  if (v === "high" || v === "medium" || v === "low") return v;
  return undefined;
}

/** Parse a DebateTurn from LLM JSON output */
export function parseDebateTurn(participant: string, text: string): DebateTurn {
  try {
    const json = extractJSON(text);
    const parsed = JSON.parse(json);
    return {
      participant,
      stance: validateStance(parsed.stance),
      summary: parsed.summary ?? parsed.argument ?? "",
      newEvidenceRefs: Array.isArray(parsed.newEvidenceRefs) ? parsed.newEvidenceRefs : undefined,
    };
  } catch {
    return {
      participant,
      stance: "uncertain",
      summary: text.slice(0, 1000),
    };
  }
}

function validateStance(v: unknown): DebateTurn["stance"] {
  if (v === "support" || v === "oppose" || v === "narrow" || v === "uncertain") return v;
  return "uncertain";
}

/** Parse a ClaimAdjudication from LLM JSON output */
export function parseAdjudication(claimId: string, text: string): ClaimAdjudication {
  try {
    const json = extractJSON(text);
    const parsed = JSON.parse(json);
    return {
      claimId,
      outcome: validateAdjudicationOutcome(parsed.outcome),
      rationale: parsed.rationale ?? "",
      finalSummary: parsed.finalSummary ?? parsed.summary ?? "",
      supportingEvidenceRefs: Array.isArray(parsed.supportingEvidenceRefs)
        ? parsed.supportingEvidenceRefs
        : [],
    };
  } catch {
    return {
      claimId,
      outcome: "unresolved",
      rationale: "Failed to parse adjudication response",
      finalSummary: text.slice(0, 500),
      supportingEvidenceRefs: [],
    };
  }
}

function validateAdjudicationOutcome(v: unknown): ClaimAdjudication["outcome"] {
  if (v === "accepted" || v === "accepted_with_revision" || v === "rejected" || v === "unresolved") return v;
  return "unresolved";
}

// ─── Planning: Detail Expansion Parser ────────────────────────────

/** Parse an ArenaRoadmapPhaseDetail from LLM JSON output */
export function parseDetailExpansion(text: string): ArenaRoadmapPhaseDetail {
  try {
    const json = extractJSON(text);
    const parsed = JSON.parse(json);
    return {
      phaseTitle: parsed.phaseTitle ?? "",
      objective: parsed.objective ?? "",
      targetFiles: toStringArray(parsed.targetFiles),
      codeChanges: toStringArray(parsed.codeChanges),
      interfaces: toStringArray(parsed.interfaces),
      migrationSteps: toStringArray(parsed.migrationSteps),
      validation: toStringArray(parsed.validation),
      effort: validateEffort(parsed.effort),
      blockers: toStringArray(parsed.blockers),
      evidenceRefs: toStringArray(parsed.evidenceRefs),
    };
  } catch {
    return {
      phaseTitle: "",
      objective: text.slice(0, 500),
      targetFiles: [],
      codeChanges: [],
      interfaces: [],
      migrationSteps: [],
      validation: [],
      effort: "medium",
      blockers: [],
      evidenceRefs: [],
    };
  }
}

function validateEffort(v: unknown): "small" | "medium" | "large" {
  if (v === "small" || v === "medium" || v === "large") return v;
  return "medium";
}
