import { createLLMClient } from "@cjhyy/code-shell-core/extension";
import { canonicalJson, sha256Hex } from "./contracts/canonical-json.js";
import type { EvalCase } from "./contracts/eval-case.js";
import type { ExperimentPlan, OperationLimits } from "./contracts/experiment.js";
import { evaluateAssertions, type AssertionResult } from "./assertions.js";
import {
  createMeteredFetch,
  type HttpObservation,
  type MeterAccounting,
} from "./providers/metered-fetch.js";
import type { ResolvedConnection } from "./providers/connection.js";

export interface Trial {
  schemaVersion: 1;
  trialId: string;
  planHash: string;
  caseId: string;
  caseHash: string;
  bodyHash: string;
  phase: "baseline" | "screening" | "holdout";
  repeat: number;
  requestModel: string;
  responseModel: string | null;
  status: "completed" | "failed" | "unknown" | "skipped";
  output: string | null;
  assertions: AssertionResult[];
  semanticStatus: "not_evaluated" | "not_applicable";
  requestIds: string[];
  observations: HttpObservation[];
  elapsedMs: number;
  reason: string | null;
}

export interface TextExecution {
  text: string | null;
  status: "completed" | "failed" | "unknown";
  observations: HttpObservation[];
  responseModel: string | null;
  elapsedMs: number;
  reason: string | null;
}

export async function executeText(options: {
  connection: ResolvedConnection;
  systemPrompt: string;
  input: string;
  limits: OperationLimits;
  maxContextBytes: number;
  accounting: MeterAccounting;
  signal?: AbortSignal;
  upstream?: typeof globalThis.fetch;
}): Promise<TextExecution> {
  const started = Date.now();
  if (Buffer.byteLength(options.systemPrompt + options.input, "utf8") > options.maxContextBytes) {
    throw new Error("trial input exceeds the frozen context limit");
  }
  const transport = createMeteredFetch(options);
  try {
    const client = await createLLMClient(options.connection.config, {
      temperature: options.connection.temperature,
      timeout: options.limits.timeoutMs,
      retryMaxAttempts: 1,
      fetch: transport.fetch,
    });
    const response = await client.createMessage({
      systemPrompt: options.systemPrompt,
      messages: [{ role: "user", content: options.input }],
      maxTokens: options.limits.maxOutputTokens,
      stream: false,
      signal: options.signal,
      billingEnabled: false,
      requestVisible: false,
    });
    const last = transport.observations.at(-1);
    const valid =
      transport.observations.length > 0 &&
      transport.observations.every(
        (item) =>
          item.outcome === "settled" && item.responseModel === options.connection.identity.modelId,
      );
    if (response.toolCalls.length > 0)
      return {
        text: null,
        status: "failed",
        observations: transport.observations,
        responseModel: last?.responseModel ?? null,
        elapsedMs: Date.now() - started,
        reason: "text-only model returned tool calls",
      };
    return {
      text: response.text,
      status: valid ? "completed" : "unknown",
      observations: transport.observations,
      responseModel: last?.responseModel ?? null,
      elapsedMs: Date.now() - started,
      reason: valid ? null : "provider model or usage evidence is missing or differs from the plan",
    };
  } catch {
    if (transport.admissionError) throw transport.admissionError;
    return {
      text: null,
      status: transport.observations.length ? "unknown" : "failed",
      observations: transport.observations,
      responseModel: transport.observations.at(-1)?.responseModel ?? null,
      elapsedMs: Date.now() - started,
      reason: options.signal?.aborted
        ? "experiment stopped or deadline elapsed"
        : "provider request failed or admission was denied",
    };
  }
}

/** A fresh call contains exactly this frozen body and this case's input. */
export async function runTrial(options: {
  plan: ExperimentPlan;
  case: EvalCase;
  body: string;
  phase: Trial["phase"];
  repeat: number;
  connection: ResolvedConnection;
  accounting: MeterAccounting;
  signal?: AbortSignal;
  upstream?: typeof globalThis.fetch;
}): Promise<Trial> {
  const bodyHash = sha256Hex(options.body);
  const identity = {
    planHash: options.plan.planHash,
    caseId: options.case.id,
    bodyHash,
    phase: options.phase,
    repeat: options.repeat,
  };
  const base = {
    schemaVersion: 1 as const,
    trialId: sha256Hex(canonicalJson(identity)),
    ...identity,
    caseHash: sha256Hex(canonicalJson(options.case)),
    requestModel: options.connection.identity.modelId,
    semanticStatus: options.case.rubric.length
      ? ("not_evaluated" as const)
      : ("not_applicable" as const),
  };
  if (options.case.readiness !== "runnable")
    return {
      ...base,
      status: "skipped",
      responseModel: null,
      output: null,
      assertions: [],
      requestIds: [],
      observations: [],
      elapsedMs: 0,
      reason: "analysis_only: no request issued",
    };
  if (options.case.fixtureRefs.length) throw new Error("unfrozen fixtures cannot be executed");
  const execution = await executeText({
    ...options,
    limits: options.plan.bounds.trial,
    maxContextBytes: options.plan.bounds.maxContextBytes,
    systemPrompt: `Optimization Lab text_fragment_v1\nApply the following frozen Skill instructions to the current user input. This is a standalone text evaluation without tools.\n\n${options.body}`,
    input: options.case.input,
  });
  return {
    ...base,
    ...execution,
    output: execution.text,
    assertions:
      execution.text === null
        ? []
        : evaluateAssertions(execution.text, options.case.hardAssertions),
    requestIds: execution.observations.map((item) => item.attemptId),
  };
}

export function hardPassed(trial: Trial): boolean {
  return trial.status === "completed" && trial.assertions.every((item) => item.passed);
}
