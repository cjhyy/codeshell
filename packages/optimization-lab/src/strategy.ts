import type { EvalCase } from "./contracts/eval-case.js";
import type { ExperimentPlan } from "./contracts/experiment.js";
import { validateCandidates, type Candidate } from "./candidate.js";
import type { ResolvedConnection } from "./providers/connection.js";
import type { MeterAccounting } from "./providers/metered-fetch.js";
import { executeText, type TextExecution, type Trial } from "./runner.js";

export interface FrozenFeedback {
  trialId: string;
  semanticPassed: boolean | null;
  criteria: {
    id: string;
    verdict: "passed" | "failed" | "inconclusive" | "not-applicable";
    evidence: string;
  }[];
}

export function reflectionInput(
  plan: ExperimentPlan,
  devCases: EvalCase[],
  trials: Trial[],
  feedback: FrozenFeedback[],
): string {
  if (devCases.some((item) => item.split !== "dev"))
    throw new Error("optimizer cannot receive holdout data");
  const devIds = new Set(devCases.map((item) => item.id));
  if (trials.some((trial) => trial.phase !== "baseline" || !devIds.has(trial.caseId)))
    throw new Error("optimizer feedback is outside the development baseline");
  return JSON.stringify({
    objective: plan.objective,
    originalBody: plan.skill.body,
    development: devCases.map((item) => ({
      caseId: item.id,
      input: item.input,
      trials: trials
        .filter((trial) => trial.caseId === item.id)
        .map((trial) => ({
          output: trial.output,
          status: trial.status,
          hardAssertions: trial.assertions,
          semanticFeedback: feedback.find((entry) => entry.trialId === trial.trialId) ?? null,
        })),
    })),
  });
}

export async function reflectOnce(options: {
  plan: ExperimentPlan;
  devCases: EvalCase[];
  trials: Trial[];
  feedback: FrozenFeedback[];
  connection: ResolvedConnection;
  accounting: MeterAccounting;
  signal?: AbortSignal;
  upstream?: typeof globalThis.fetch;
}): Promise<{ execution: TextExecution; candidates: Candidate[]; rejection: string | null }> {
  const execution = await executeText({
    ...options,
    limits: options.plan.bounds.optimization,
    maxContextBytes: options.plan.bounds.maxContextBytes,
    systemPrompt: `Optimization Lab reflect_once_v1\nPropose 1 to ${options.plan.bounds.maxCandidates} improved complete Skill bodies. Return only JSON matching {"candidates":[{"body":"complete text body without frontmatter","explanation":"why this helps","sourceCaseIds":["development case id"]}]}. Keep all changes within the supplied development evidence. Do not change metadata, the scorer, or use tools.`,
    input: reflectionInput(options.plan, options.devCases, options.trials, options.feedback),
  });
  if (execution.status !== "completed" || execution.text === null)
    return {
      execution,
      candidates: [],
      rejection: "optimizer did not return a verified text response",
    };
  try {
    const candidates = validateCandidates(execution.text, {
      parentBodyHash: options.plan.skill.bodyHash,
      frontmatterOriginal: options.plan.skill.frontmatterOriginal,
      devCaseIds: options.devCases.map((item) => item.id),
      maxCandidates: options.plan.bounds.maxCandidates,
      maxBodyBytes: options.plan.bounds.maxBodyBytes,
      maxContextBytes: options.plan.bounds.maxContextBytes,
    });
    return { execution, candidates, rejection: null };
  } catch {
    return {
      execution,
      candidates: [],
      rejection: "optimizer response violates the frozen candidate contract",
    };
  }
}
