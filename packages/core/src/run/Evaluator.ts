/**
 * Evaluator — contract for run completion evaluation.
 *
 * An evaluator inspects a completed (or about-to-complete) run and produces
 * a structured verdict. This enables:
 *   - Automated quality gates before marking a run as "completed"
 *   - Product-specific acceptance criteria
 *   - CI/CD integration for agent-driven workflows
 *
 * The evaluator is intentionally decoupled from the Engine:
 *   - It runs AFTER the Engine finishes, not during the turn loop
 *   - It receives the run snapshot + final checkpoint, not raw messages
 *   - Its result is written into the checkpoint's `evaluator` field
 *
 * Phase 5 provides the contract; concrete implementations are domain-specific.
 */

import type { RunSnapshot, RunCheckpoint, RunArtifactRef } from "./types.js";

// ─── Evaluator Result ────────────────────────────────────────────

export type EvaluatorVerdict = "passed" | "failed" | "warning";

export interface EvaluatorResult {
  verdict: EvaluatorVerdict;
  findings: string[];
  /** Optional structured data for programmatic consumption. */
  details?: Record<string, unknown>;
}

// ─── Evaluator Context ───────────────────────────────────────────

export interface EvaluatorContext {
  run: RunSnapshot;
  checkpoint: RunCheckpoint;
  artifacts: RunArtifactRef[];
}

// ─── Evaluator Contract ──────────────────────────────────────────

export interface Evaluator {
  /** Human-readable name for logging and display. */
  readonly name: string;

  /**
   * Evaluate a run's final state.
   * Should NOT have side effects beyond reading files/state.
   * Must be safe to call multiple times on the same run.
   */
  evaluate(context: EvaluatorContext): Promise<EvaluatorResult>;
}

// ─── Built-in: Noop Evaluator ────────────────────────────────────

/**
 * Default evaluator that always passes. Used when no evaluator is configured.
 */
export class NoopEvaluator implements Evaluator {
  readonly name = "noop";

  async evaluate(): Promise<EvaluatorResult> {
    return { verdict: "passed", findings: [] };
  }
}

// ─── Built-in: Composite Evaluator ──────────────────────────────

/**
 * Runs multiple evaluators and merges their results.
 * The overall verdict is the worst across all evaluators.
 */
export class CompositeEvaluator implements Evaluator {
  readonly name: string;
  private readonly evaluators: Evaluator[];

  constructor(evaluators: Evaluator[]) {
    this.evaluators = evaluators;
    this.name = `composite(${evaluators.map((e) => e.name).join(", ")})`;
  }

  async evaluate(context: EvaluatorContext): Promise<EvaluatorResult> {
    const allFindings: string[] = [];
    let worstVerdict: EvaluatorVerdict = "passed";
    const details: Record<string, unknown> = {};

    for (const evaluator of this.evaluators) {
      const result = await evaluator.evaluate(context);
      allFindings.push(...result.findings.map((f) => `[${evaluator.name}] ${f}`));

      if (result.verdict === "failed") {
        worstVerdict = "failed";
      } else if (result.verdict === "warning" && worstVerdict !== "failed") {
        worstVerdict = "warning";
      }

      if (result.details) {
        details[evaluator.name] = result.details;
      }
    }

    return {
      verdict: worstVerdict,
      findings: allFindings,
      details: Object.keys(details).length > 0 ? details : undefined,
    };
  }
}
