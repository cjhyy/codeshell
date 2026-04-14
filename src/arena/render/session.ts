/**
 * Session renderer — formats ArenaResultV2 into markdown suitable for
 * displaying as assistant_text and as context for follow-up LLM turns.
 *
 * Review mode output order:
 *   1. Change Summary — what changed (factual)
 *   2. Overall assessment
 *   3. Strengths
 *   4. Risks
 *   5. Improvements
 *   6. Open Questions
 *   7. Next Actions
 *   8. Per-participant findings (collapsed)
 */

import type { ArenaResultV2, ArenaConsensusItem } from "../types.js";

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

  // 1. Change Summary — what changed (factual, before judgment)
  if (c.changeSummary) {
    lines.push("### What Changed");
    lines.push(c.changeSummary);
    lines.push("");
  }

  // 2. Overall assessment
  if (c.summary) {
    lines.push("### Overall Assessment");
    lines.push(c.summary);
    lines.push("");
  }

  // 3. Strengths
  if (c.strengths.length > 0) {
    lines.push("### ✓ Strengths");
    for (const item of c.strengths) {
      lines.push(`- **${item.title}**: ${item.summary}`);
    }
    lines.push("");
  }

  // 4. Risks (before improvements — high priority first)
  if (c.risks.length > 0) {
    lines.push("### ⚠ Risks");
    for (const item of c.risks) {
      lines.push(`- **${item.title}**: ${item.summary}`);
    }
    lines.push("");
  }

  // 5. Improvements
  if (c.improvements.length > 0) {
    lines.push("### → Improvements");
    for (const item of c.improvements) {
      lines.push(`- **${item.title}**: ${item.summary}`);
    }
    lines.push("");
  }

  // 6. Open Questions
  if (c.openQuestions.length > 0) {
    lines.push("### ? Open Questions");
    for (const item of c.openQuestions) {
      lines.push(`- **${item.title}**: ${item.summary}`);
    }
    lines.push("");
  }

  // 7. Next Actions
  if (c.nextActions.length > 0) {
    lines.push("### Next Actions");
    for (const action of c.nextActions) {
      const pri = action.priority === "high" ? "🔴" : action.priority === "medium" ? "🟡" : "⚪";
      lines.push(`- ${pri} **${action.title}**: ${action.rationale}`);
    }
    lines.push("");
  }

  // 8. Per-participant findings (detail section)
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
