/** Shared utilities for arena strategy implementations. */

import type { ArenaBaseContext, ArenaFinding, FindingReview, ParticipantReport, ArenaConsensus, ArenaConsensusItem, PeerVerdict, FindingKind } from "../types.js";
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

  // Scope info
  sections.push(`## Scope\n${ctx.scope.label}`);

  // Git facts
  if (ctx.gitFacts) {
    const gf = ctx.gitFacts;
    const gitLines: string[] = [];
    if (gf.currentBranch) gitLines.push(`Branch: ${gf.currentBranch}`);
    if (gf.baseRef) gitLines.push(`Base: ${gf.baseRef}`);
    if (gf.headRef) gitLines.push(`Head: ${gf.headRef}`);
    if (gf.commitLog?.length) {
      gitLines.push(`\nCommit Log:\n${gf.commitLog.join("\n")}`);
    }
    if (gf.diffStat) gitLines.push(`\nDiff Stat:\n${gf.diffStat}`);
    if (gf.changedFiles?.length) {
      gitLines.push(`\nChanged Files:\n${gf.changedFiles.join("\n")}`);
    }
    sections.push(`## Git Facts\n${gitLines.join("\n")}`);
  }

  // Code facts
  if (ctx.codeFacts.keyFiles.length > 0) {
    sections.push(`## Key Files\n${ctx.codeFacts.keyFiles.join("\n")}`);
  }
  if (ctx.codeFacts.fileSummaries.length > 0) {
    sections.push(`## File Summaries\n${ctx.codeFacts.fileSummaries.map((f) => `${f.path}: ${f.summary}`).join("\n")}`);
  }

  // Raw artifacts
  for (const artifact of ctx.rawArtifacts) {
    sections.push(`## ${artifact.kind.toUpperCase()}: ${artifact.id}\n\`\`\`\n${artifact.preview}\n\`\`\``);
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
      changeSummary: parsed.changeSummary || undefined,
      strengths: parseConsensusItems(parsed.strengths),
      improvements: parseConsensusItems(parsed.improvements),
      risks: parseConsensusItems(parsed.risks),
      openQuestions: parseConsensusItems(parsed.openQuestions),
      nextActions: Array.isArray(parsed.nextActions)
        ? parsed.nextActions.map((a: any) => ({
            title: a.title ?? "",
            priority: a.priority ?? "medium",
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
