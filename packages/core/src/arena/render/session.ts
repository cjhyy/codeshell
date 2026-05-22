/**
 * Session renderer — formats ArenaResultV2 into markdown suitable for
 * displaying as assistant_text and as context for follow-up LLM turns.
 *
 * Scene-aware output order:
 *   1. Subject Summary — factual framing / what changed / current scope
 *   2. Overall assessment
 *   3. Roadmap (planning-first when present)
 *   4. Consensus sections ordered by output emphasis
 *   5. Next Actions
 *   6. Per-participant findings (collapsed)
 */

import type {
  ArenaResultV2,
  ArenaRoadmapPhase,
  ArenaRoadmapPhaseDetail,
  ArenaConsensusItem,
  FindingKind,
} from "../types.js";

/**
 * Format an ArenaResultV2 into markdown text.
 */
export function formatArenaResultForSession(result: ArenaResultV2): string {
  const lines: string[] = [];
  const modeLabel = result.mode.charAt(0).toUpperCase() + result.mode.slice(1);

  lines.push(`## Arena ${modeLabel} Result`);
  lines.push(`**Topic:** ${result.topic}`);
  lines.push(`**Models:** ${result.participants.join(" vs ")}`);
  lines.push("");

  const c = result.consensus;

  // 1. Subject Summary — factual overview (adapts label per mode)
  if (c.subjectSummary) {
    const overviewLabel = result.plan.outputShape.overviewLabel
      ?? (result.mode === "review" ? "What Changed"
        : result.mode === "planning" ? "Current Scope"
        : "Problem Framing");
    lines.push(`### ${overviewLabel}`);
    lines.push(c.subjectSummary);
    lines.push("");
  }

  // 2. Overall assessment
  if (c.summary) {
    lines.push("### Overall Assessment");
    lines.push(c.summary);
    lines.push("");
  }

  // 3. Roadmap — surfaced early for planning scenes
  if (result.mode === "planning" && c.roadmap.length > 0) {
    lines.push("### Roadmap");
    for (const [index, phase] of c.roadmap.entries()) {
      lines.push(...formatRoadmapPhase(index, phase));
    }
    lines.push("");

    // 3b. Implementation Details — expanded phase details
    if (c.roadmapDetails && c.roadmapDetails.length > 0) {
      lines.push("### Implementation Details");
      for (const detail of c.roadmapDetails) {
        lines.push(...formatPhaseDetail(detail));
      }
      lines.push("");
    }
  }

  // 4. Consensus sections ordered by output emphasis
  for (const section of getOrderedConsensusSections(result)) {
    lines.push(`### ${section.title}`);
    for (const item of section.items) {
      lines.push(`- **${item.title}**: ${item.summary}`);
    }
    lines.push("");
  }

  // 5. Roadmap for non-planning scenes
  if (result.mode !== "planning" && c.roadmap.length > 0) {
    lines.push("### Roadmap");
    for (const [index, phase] of c.roadmap.entries()) {
      lines.push(...formatRoadmapPhase(index, phase));
    }
    lines.push("");
  }

  // 6. Next Actions
  if (c.nextActions.length > 0) {
    lines.push("### Next Actions");
    for (const action of c.nextActions) {
      const pri = action.priority === "high" ? "🔴" : action.priority === "medium" ? "🟡" : "⚪";
      lines.push(`- ${pri} **${action.title}**: ${action.rationale}`);
    }
    lines.push("");
  }

  // 7. Per-participant findings (detail section)
  if (result.reports.some((r) => r.findings.length > 0)) {
    lines.push("---");
    lines.push("### Participant Findings");
    for (const report of result.reports) {
      if (report.findings.length === 0) {
        lines.push(`\n**${report.participant}**: ${report.contextSummary || "(no findings)"}`);
        continue;
      }
      lines.push(`\n**${report.participant}** (${report.findings.length} findings)`);
      if (report.contextSummary) {
        lines.push(`> ${report.contextSummary}`);
      }
      for (const f of report.findings) {
        const severity = f.severity ? `/${f.severity}` : "";
        lines.push(`- [${f.kind}${severity}] **${f.title}**: ${f.summary}`);
      }
    }
  }

  return lines.join("\n");
}

function formatRoadmapPhase(index: number, phase: ArenaRoadmapPhase): string[] {
  const pri = phase.priority === "high" ? "High" : phase.priority === "medium" ? "Medium" : "Low";
  const lines = [`#### Phase ${index + 1}: ${phase.title} (${pri} priority)`];

  if (phase.goal) {
    lines.push(`Goal: ${phase.goal}`);
  }
  if (phase.scope.length > 0) {
    lines.push(`Scope: ${phase.scope.join("; ")}`);
  }
  if (phase.deliverables.length > 0) {
    lines.push(`Deliverables: ${phase.deliverables.join("; ")}`);
  }
  if (phase.dependencies.length > 0) {
    lines.push(`Dependencies: ${phase.dependencies.join("; ")}`);
  }
  if (phase.risks.length > 0) {
    lines.push(`Risks: ${phase.risks.join("; ")}`);
  }
  if (phase.successCriteria.length > 0) {
    lines.push(`Success Criteria: ${phase.successCriteria.join("; ")}`);
  }
  lines.push("");

  return lines;
}

function formatPhaseDetail(detail: ArenaRoadmapPhaseDetail): string[] {
  const effort = detail.effort === "large" ? "Large" : detail.effort === "small" ? "Small" : "Medium";
  const lines = [`#### ${detail.phaseTitle} (${effort} effort)`];

  if (detail.objective) {
    lines.push(detail.objective);
  }
  if (detail.targetFiles.length > 0) {
    lines.push(`**Target files:** ${detail.targetFiles.map((f) => "`" + f + "`").join(", ")}`);
  }
  if (detail.codeChanges.length > 0) {
    lines.push("**Code changes:**");
    for (const change of detail.codeChanges) {
      lines.push(`- ${change}`);
    }
  }
  if (detail.interfaces.length > 0) {
    lines.push(`**Interfaces:** ${detail.interfaces.join("; ")}`);
  }
  if (detail.migrationSteps.length > 0) {
    lines.push("**Migration steps:**");
    for (const [i, step] of detail.migrationSteps.entries()) {
      lines.push(`${i + 1}. ${step}`);
    }
  }
  if (detail.validation.length > 0) {
    lines.push(`**Validation:** ${detail.validation.join("; ")}`);
  }
  if (detail.blockers.length > 0) {
    lines.push(`**Blockers:** ${detail.blockers.join("; ")}`);
  }
  lines.push("");

  return lines;
}

function getOrderedConsensusSections(result: ArenaResultV2): Array<{
  kind: FindingKind;
  title: string;
  items: ArenaConsensusItem[];
}> {
  const VALID_KINDS: Set<string> = new Set(["strength", "improvement", "risk", "question"]);
  const defaultOrder: FindingKind[] = ["risk", "improvement", "strength", "question"];
  const emphasize = (result.plan?.outputShape?.emphasize ?? []).filter((k): k is FindingKind => VALID_KINDS.has(k));
  const orderedKinds = dedupeFindingKinds([...emphasize, ...defaultOrder]);
  const sections = orderedKinds.map((kind) => {
    switch (kind) {
      case "strength":
        return { kind, title: "✓ Strengths", items: result.consensus.strengths };
      case "improvement":
        return { kind, title: "→ Improvements", items: result.consensus.improvements };
      case "risk":
        return { kind, title: "⚠ Risks", items: result.consensus.risks };
      case "question":
        return { kind, title: "? Open Questions", items: result.consensus.openQuestions };
    }
  });

  return sections
    .filter((section): section is NonNullable<typeof section> => section != null)
    .filter((section) => section.items.length > 0);
}

function dedupeFindingKinds(kinds: FindingKind[]): FindingKind[] {
  const seen = new Set<FindingKind>();
  const result: FindingKind[] = [];
  for (const kind of kinds) {
    if (!seen.has(kind)) {
      seen.add(kind);
      result.push(kind);
    }
  }
  return result;
}
