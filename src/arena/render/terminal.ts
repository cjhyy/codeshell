/**
 * Terminal renderer — renders ArenaConsensus and ArenaResultV2.
 *
 * All render functions return strings instead of printing directly,
 * so callers can decide where to display (ctx.addStatus vs console.log).
 *
 * Output sections:
 * 1. Strengths (what's done well)
 * 2. Improvements (what needs work)
 * 3. Risks (high-priority concerns)
 * 4. Open Questions (needs clarification)
 * 5. Next Actions (recommended changes)
 */

import chalk from "chalk";
import type {
  ArenaResultV2,
  ArenaConsensus,
  ArenaConsensusItem,
  ArenaProgressEvent,
  ParticipantReport,
} from "../types.js";

/** Output sink — callers provide this to control where text goes. */
export type OutputSink = (text: string) => void;

/**
 * Format the full arena result as a styled string.
 */
export function formatArenaResult(result: ArenaResultV2): string {
  const modeLabel = result.mode.charAt(0).toUpperCase() + result.mode.slice(1);
  const lines: string[] = [];

  lines.push("");
  lines.push(chalk.bold(`  ═══ ${modeLabel} Conclusion ═══`));
  lines.push("");

  // Summary
  if (result.consensus.summary) {
    lines.push(`  ${result.consensus.summary}`);
    lines.push("");
  }

  // Strengths
  lines.push(...formatConsensusSection("Strengths", result.consensus.strengths, chalk.green, "✓"));

  // Improvements
  lines.push(...formatConsensusSection("Improvements", result.consensus.improvements, chalk.yellow, "→"));

  // Risks
  lines.push(...formatConsensusSection("Risks", result.consensus.risks, chalk.red, "⚠"));

  // Open Questions
  lines.push(...formatConsensusSection("Open Questions", result.consensus.openQuestions, chalk.cyan, "?"));

  // Next Actions
  if (result.consensus.nextActions.length > 0) {
    lines.push(chalk.bold.white("\n  Next Actions:"));
    for (const action of result.consensus.nextActions) {
      const pri = action.priority === "high"
        ? chalk.red("HIGH")
        : action.priority === "medium"
          ? chalk.yellow("MED")
          : chalk.dim("LOW");
      lines.push(`    ${chalk.white("→")} [${pri}${chalk.white("]")} ${action.title}`);
      if (action.rationale) {
        lines.push(chalk.dim(`      ${action.rationale}`));
      }
    }
  }

  // Footer
  lines.push("");
  lines.push(chalk.dim(
    `  Mode: ${modeLabel} | ` +
    `Findings: ${countFindings(result)} | ` +
    `Models: ${result.participants.join(", ")}`,
  ));
  lines.push("");

  return lines.join("\n");
}

/**
 * Print the full arena result directly to stdout.
 * Used by the CLI `code-shell arena` command (non-REPL).
 */
export function printArenaResult(result: ArenaResultV2): void {
  console.log(formatArenaResult(result));
}

function formatConsensusSection(
  title: string,
  items: ArenaConsensusItem[],
  color: (text: string) => string,
  icon: string,
): string[] {
  if (items.length === 0) return [];

  const lines: string[] = [];
  lines.push(color(`\n  ${title}:`));
  for (const item of items) {
    lines.push(color(`    ${icon} ${item.title}`));
    if (item.summary) {
      lines.push(chalk.dim(`      ${item.summary}`));
    }
    if (item.challenge.length > 0) {
      lines.push(chalk.dim(`      Challenged by: ${item.challenge.join(", ")}`));
    }
  }
  return lines;
}

function countFindings(result: ArenaResultV2): number {
  return result.reports.reduce((sum, r) => sum + r.findings.length, 0);
}

/**
 * Create a progress renderer that sends output to a sink.
 * For REPL: pass ctx.addStatus. For CLI: pass console.log.
 */
export function createProgressRenderer(sink: OutputSink): (event: ArenaProgressEvent) => void {
  return (event: ArenaProgressEvent) => {
    switch (event.type) {
      case "intent_resolved":
        sink(chalk.dim(
          `Intent: ${event.intent.mode} / ${event.intent.targetType}` +
          (event.intent.confidence !== "high" ? ` (${event.intent.confidence} confidence)` : ""),
        ));
        break;

      case "scope_resolved":
        sink(chalk.dim(`Scope: ${event.scope.label}`));
        break;

      case "facts_collected": {
        const artCount = event.context.rawArtifacts.length;
        const fileCount = event.context.codeFacts.keyFiles.length;
        sink(chalk.dim(`Collected ${artCount} artifacts, ${fileCount} key files`));
        break;
      }

      case "research_start":
        sink(chalk.dim(`⏳ ${event.participant} researching...`));
        break;

      case "research_done": {
        const fCount = event.report.findings.length;
        sink(`${event.participant}: ${chalk.green("done")} (${fCount} findings)`);
        break;
      }

      case "context_lookup":
        for (const t of event.tools) {
          sink(chalk.dim(`  🔍 ${event.participant}: ${t}`));
        }
        break;

      case "cross_review_start":
        sink(chalk.dim("── Cross Review ──"));
        break;

      case "cross_review_done":
        sink(chalk.dim(`${event.reviews.length} peer reviews collected`));
        break;

      case "consensus_start":
        sink(chalk.dim("⏳ Building consensus..."));
        break;

      case "consensus_done":
        break;
    }
  };
}

/**
 * Legacy: direct console.log progress renderer for CLI mode.
 */
export function renderProgress(event: ArenaProgressEvent): void {
  createProgressRenderer((text) => console.log(`  ${text}`))(event);
}
