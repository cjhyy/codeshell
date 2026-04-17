/**
 * Terminal renderer — renders ArenaConsensus and ArenaResultV2.
 *
 * All render functions return strings instead of printing directly,
 * so callers can decide where to display (ctx.addStatus vs console.log).
 *
 * Output sections:
 * 1. Summary
 * 2. Roadmap (surfaced early for planning scenes)
 * 3. Consensus sections ordered by output emphasis
 * 4. Next Actions
 */

import chalk from "chalk";
import type {
  ArenaResultV2,
  ArenaConsensusItem,
  ArenaProgressEvent,
  ArenaRoadmapPhase,
  ArenaRoadmapPhaseDetail,
  FindingKind,
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

  // Roadmap first for planning scenes
  if (result.mode === "planning") {
    lines.push(...formatRoadmapSection(result.consensus.roadmap));
    if (result.consensus.roadmapDetails && result.consensus.roadmapDetails.length > 0) {
      lines.push(...formatRoadmapDetailsSection(result.consensus.roadmapDetails));
    }
  }

  // Consensus sections ordered by output emphasis
  for (const section of getOrderedConsensusSections(result)) {
    lines.push(...formatConsensusSection(section.title, section.items, section.color, section.icon));
  }

  // Roadmap after findings for non-planning scenes
  if (result.mode !== "planning") {
    lines.push(...formatRoadmapSection(result.consensus.roadmap));
  }

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
  const planInfo = result.plan
    ? ` | Lenses: ${result.plan.lenses.map((l) => l.name).join(", ")} | Sources: ${result.plan.sources.map((s) => s.kind).join(", ")}`
    : "";
  lines.push(chalk.dim(
    `  Mode: ${modeLabel} | ` +
    `Findings: ${countFindings(result)} | ` +
    `Models: ${result.participants.join(", ")}` +
    planInfo,
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

function formatRoadmapSection(phases: ArenaRoadmapPhase[]): string[] {
  if (phases.length === 0) return [];

  const lines: string[] = [];
  lines.push(chalk.bold.white("\n  Roadmap:"));
  for (const [index, phase] of phases.entries()) {
    const pri = phase.priority === "high"
      ? chalk.red("HIGH")
      : phase.priority === "medium"
        ? chalk.yellow("MED")
        : chalk.dim("LOW");
    lines.push(`    ${chalk.white("→")} Phase ${index + 1}: ${phase.title} [${pri}${chalk.white("]")}`);
    if (phase.goal) {
      lines.push(chalk.dim(`      Goal: ${phase.goal}`));
    }
    if (phase.scope.length > 0) {
      lines.push(chalk.dim(`      Scope: ${phase.scope.join("; ")}`));
    }
    if (phase.deliverables.length > 0) {
      lines.push(chalk.dim(`      Deliverables: ${phase.deliverables.join("; ")}`));
    }
    if (phase.dependencies.length > 0) {
      lines.push(chalk.dim(`      Dependencies: ${phase.dependencies.join("; ")}`));
    }
    if (phase.risks.length > 0) {
      lines.push(chalk.dim(`      Risks: ${phase.risks.join("; ")}`));
    }
    if (phase.successCriteria.length > 0) {
      lines.push(chalk.dim(`      Success: ${phase.successCriteria.join("; ")}`));
    }
  }
  return lines;
}

function formatRoadmapDetailsSection(details: ArenaRoadmapPhaseDetail[]): string[] {
  const lines: string[] = [];
  lines.push(chalk.bold.white("\n  Implementation Details:"));
  for (const detail of details) {
    const effort = detail.effort === "large"
      ? chalk.red("L")
      : detail.effort === "medium"
        ? chalk.yellow("M")
        : chalk.green("S");
    lines.push(`\n    ${chalk.white("▸")} ${detail.phaseTitle} [${effort}]`);
    if (detail.objective) {
      lines.push(chalk.dim(`      ${detail.objective}`));
    }
    if (detail.targetFiles.length > 0) {
      lines.push(chalk.dim(`      Files: ${detail.targetFiles.join(", ")}`));
    }
    if (detail.codeChanges.length > 0) {
      for (const change of detail.codeChanges) {
        lines.push(chalk.dim(`      • ${change}`));
      }
    }
    if (detail.interfaces.length > 0) {
      lines.push(chalk.dim(`      Interfaces: ${detail.interfaces.join("; ")}`));
    }
    if (detail.migrationSteps.length > 0) {
      lines.push(chalk.dim(`      Migration:`));
      for (const [i, step] of detail.migrationSteps.entries()) {
        lines.push(chalk.dim(`        ${i + 1}. ${step}`));
      }
    }
    if (detail.validation.length > 0) {
      lines.push(chalk.dim(`      Validation: ${detail.validation.join("; ")}`));
    }
    if (detail.blockers.length > 0) {
      lines.push(chalk.red(`      Blockers: ${detail.blockers.join("; ")}`));
    }
  }
  return lines;
}

function getOrderedConsensusSections(result: ArenaResultV2): Array<{
  kind: FindingKind;
  title: string;
  items: ArenaConsensusItem[];
  color: (text: string) => string;
  icon: string;
}> {
  const VALID_KINDS: Set<string> = new Set(["strength", "improvement", "risk", "question"]);
  const defaultOrder: FindingKind[] = ["risk", "improvement", "strength", "question"];
  const emphasize = (result.plan?.outputShape?.emphasize ?? []).filter((k): k is FindingKind => VALID_KINDS.has(k));
  const orderedKinds = dedupeFindingKinds([...emphasize, ...defaultOrder]);

  return orderedKinds
    .map((kind) => {
      switch (kind) {
        case "strength":
          return { kind, title: "Strengths", items: result.consensus.strengths, color: chalk.green, icon: "✓" };
        case "improvement":
          return { kind, title: "Improvements", items: result.consensus.improvements, color: chalk.yellow, icon: "→" };
        case "risk":
          return { kind, title: "Risks", items: result.consensus.risks, color: chalk.red, icon: "⚠" };
        case "question":
          return { kind, title: "Open Questions", items: result.consensus.openQuestions, color: chalk.cyan, icon: "?" };
      }
    })
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

/**
 * Create a progress renderer that sends output to a sink.
 * For REPL: pass ctx.addStatus. For CLI: pass console.log.
 */
export function createProgressRenderer(sink: OutputSink): (event: ArenaProgressEvent) => void {
  return (event: ArenaProgressEvent) => {
    switch (event.type) {
      case "plan_resolved":
        sink(chalk.dim(
          `Plan: ${event.plan.mode} | ` +
          `lenses: ${event.plan.lenses.map((l) => l.name).join(", ")} | ` +
          `sources: ${event.plan.sources.map((s) => s.kind).join(", ")}` +
          (event.plan.confidence !== "high" ? ` (${event.plan.confidence} confidence)` : ""),
        ));
        break;

      case "evidence_collected":
        sink(chalk.dim(`Evidence: ${event.artifacts.length} artifacts collected`));
        break;

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

      case "claims_registered":
        sink(chalk.dim(`${event.claimCount} claims registered`));
        break;

      case "cross_review_start":
        sink(chalk.dim("── Cross Review ──"));
        break;

      case "cross_review_done":
        sink(chalk.dim(`${event.reviews.length} peer reviews collected`));
        break;

      case "verification_start":
        sink(chalk.dim("── Verification Review ──"));
        break;

      case "verification_done":
        sink(chalk.dim(`${event.challengeCount} challenges raised`));
        break;

      case "debate_round_start":
        sink(chalk.dim(`── Debate Round ${event.round} (${event.claims.length} claims) ──`));
        break;

      case "debate_round_done":
        sink(chalk.dim(`Round ${event.round}: ${event.resolved} resolved`));
        break;

      case "adjudication_done":
        sink(chalk.dim(`Adjudication: ${event.accepted} accepted, ${event.unresolved} unresolved`));
        break;

      case "planning_merge_review_start":
        sink(chalk.dim("── Planning Merge Review ──"));
        break;

      case "planning_merge_review_done":
        sink(chalk.dim(`${event.mergeCount} merge suggestions collected`));
        break;

      case "roadmap_expansion_start":
        sink(chalk.dim(`── Expanding ${event.phaseCount} roadmap phases ──`));
        break;

      case "roadmap_expansion_done":
        sink(chalk.dim(`${event.detailCount} phase details generated`));
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
