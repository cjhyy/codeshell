#!/usr/bin/env bun
// Offline by default. Live mode sends synthetic requests only, never executes target tools.
import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { Message, ToolDefinition } from "../../../packages/core/src/types.js";
import type { ToolContext } from "../../../packages/core/src/tool-system/context.js";
import { RunToolSurface } from "../../../packages/core/src/tool-system/run-tool-surface.js";
import {
  toolSearchTool,
  toolSearchToolDef,
} from "../../../packages/core/src/tool-system/builtin/tool-search.js";
import { callToolDef } from "../../../packages/core/src/tool-system/builtin/call-tool.js";
import {
  validateToolArgsStrict,
  validateToolInputSchemaStrict,
} from "../../../packages/core/src/tool-system/validation.js";
import {
  anthropicMessages,
  anthropicSystem,
  anthropicTools,
} from "../../../packages/core/src/llm/providers/anthropic-discovery-wire.js";
import { resolvePromptCachePolicy } from "../../../packages/core/src/llm/prompt-cache.js";
import {
  selectionForToolCacheCycle,
  toolCacheIdleLimitMs,
} from "../../../packages/core/src/engine/tool-cache-cycle.js";
import { VERSION } from "../../../packages/core/src/version.js";
import {
  complexSchemaCases,
  complexSchemaDefinitions,
  compareComplexSchemaArgs,
} from "./complex-schema-cases-20261112.mjs";
import { loadCredential, prepareEvidence, usageEvidence } from "./native-tool-reference-probe.mjs";
import {
  LIMITS,
  ROUTING,
  openBudgetLedger,
  sendExact,
  validateBody,
} from "./complex-probe-budget-20261112.mjs";

export const MODES = ["eager", "native", "call-tool"] as const;
export type Mode = (typeof MODES)[number];
export const PLANNED_REQUESTS = 70;
const CONFIG = {
  provider: "anthropic" as const,
  providerKind: "openrouter" as const,
  model: "anthropic/claude-sonnet-5",
  baseUrl: "https://openrouter.ai/api/v1",
  reasoning: { mode: "off" as const },
};
const PRIOR_EVIDENCE = resolve(import.meta.dirname, "native-tool-reference-evidence-20261111.json");
const MANUAL = Array.from(
  { length: 64 },
  (_, i) =>
    `Synthetic manual record ${String(i).padStart(3, "0")}: preserve exact requested values, nested object structure, array order and explicit null. Omitted optional fields stay absent. Tools simulate imaginary records and have no external effects.`,
).join("\n");

export function discoveryDefinition(mode: Mode): ToolDefinition {
  return mode !== "native"
    ? toolSearchToolDef
    : {
        ...toolSearchToolDef,
        // Same native guidance as initializeRunToolSurface; checked against production in tests.
        description:
          'Find available tools by keyword, then use "select:ToolName" (or comma-separated names) to load their definitions. ' +
          "Invoke tools returned as native references directly by their exact names with schema-matching arguments. " +
          "For tools returned as full schema text, use CallTool with the exact name and matching args. " +
          "If an exact tool is unavailable, do not retry unless the Session context changes.",
      };
}

export function surfaceFor(mode: Mode, selection?: unknown): RunToolSurface {
  const identity = `synthetic-complex-study:${mode}`;
  const surface = new RunToolSurface(mode === "eager" ? undefined : ["ToolSearch"], {
    selection: selectionForToolCacheCycle(selection, identity, {
      now: Date.now(),
      cacheVersion: VERSION,
      idleLimitMs: toolCacheIdleLimitMs(CONFIG),
    }),
    cacheIdentity: identity,
    cacheVersion: VERSION,
    toolDiscovery: mode === "native" ? "tool-reference" : "call-tool",
  });
  surface.updateCatalog([discoveryDefinition(mode), callToolDef, ...complexSchemaDefinitions]);
  return surface;
}

export function bodyFor(
  mode: Mode,
  surface: RunToolSurface,
  messages: Message[],
  stableCount: number,
  nonce: string,
) {
  const policy = {
    ...resolvePromptCachePolicy(CONFIG),
    toolDiscovery: mode === "native" ? ("tool-reference" as const) : ("call-tool" as const),
  };
  const tools = surface.requestSnapshot();
  const guidance =
    mode === "call-tool"
      ? "After ToolSearch loads a schema, invoke CallTool with that exact name and its matching args object."
      : "Invoke the requested synthetic target directly by its exact name with matching arguments.";
  const body = {
    model: LIMITS.model,
    max_tokens: LIMITS.maxOutputTokens,
    stream: false,
    thinking: { type: "disabled" },
    // Probe-only pin and rate filter. Production does not forward extraBody.provider.
    provider: ROUTING,
    tools: anthropicTools(tools, policy),
    system: anthropicSystem(
      `Synthetic complex-schema study ${nonce}, mode ${mode}. All target tools are inert. ${guidance} ` +
        "Use exactly one requested tool per task, emit no other tool calls, and do not execute real operations. " +
        "When asked only to discover, call ToolSearch and await the next instruction. When asked to reply DONE, emit DONE without tools.\n" +
        MANUAL,
      policy,
    ),
    messages: anthropicMessages(messages, { stablePrefixMessageCount: stableCount }, policy, tools),
  };
  validateBody(body);
  return body;
}

const text = (value: string): Message => ({
  role: "user",
  content: [{ type: "text", text: value }],
});
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export function withoutMarkers(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutMarkers);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => key !== "cache_control")
        .map(([key, item]) => [key, withoutMarkers(item)]),
    );
  return value;
}
export function assertAppendOnly(before: any, after: any): void {
  if (
    JSON.stringify(before.tools) !== JSON.stringify(after.tools) ||
    JSON.stringify(before.system) !== JSON.stringify(after.system)
  )
    throw new Error("Frozen tool/system bytes changed");
  if (
    JSON.stringify(withoutMarkers(before.messages)) !==
    JSON.stringify(withoutMarkers(after.messages.slice(0, before.messages.length)))
  )
    throw new Error("Prior message bytes changed beyond cache markers");
}
export function coldControl(body: any, nonce: string) {
  const next = structuredClone(body);
  next.tools[0].description = `Cold-control prefix ${nonce}. ` + next.tools[0].description;
  validateBody(next);
  return next;
}

function singleCall(response: any) {
  if (response.stop_reason !== "tool_use" || !Array.isArray(response.content)) return undefined;
  if (
    response.content.some(
      (part: any) => part.type === "server_tool_use" || part.type === "thinking",
    )
  )
    return undefined;
  const calls = response.content.filter((part: any) => part.type === "tool_use");
  return calls.length === 1 && typeof calls[0].id === "string" && calls[0].id
    ? calls[0]
    : undefined;
}

export function scoreResponse(mode: Mode, sample: any, response: any) {
  const call = singleCall(response);
  const target = complexSchemaDefinitions.find((item) => item.name === sample.toolName)!;
  const args = mode === "call-tool" ? call?.input?.args : call?.input;
  const identityValid =
    !!call &&
    (mode === "call-tool"
      ? call.name === "CallTool" && call.input?.name === sample.toolName
      : call.name === sample.toolName);
  const wrapperError =
    mode === "call-tool" && call
      ? validateToolArgsStrict("CallTool", call.input, callToolDef.inputSchema)
      : null;
  const schemaError =
    args && typeof args === "object" && !Array.isArray(args)
      ? validateToolArgsStrict(sample.toolName, args, target.inputSchema)
      : "Arguments are not an object";
  const semantic = compareComplexSchemaArgs(args, sample.expectedArgs);
  return {
    identityValid,
    schemaValid: identityValid && !wrapperError && !schemaError,
    semanticValid: identityValid && semantic.matches,
    correct: identityValid && !wrapperError && !schemaError && semantic.matches,
    truncated: response.stop_reason === "max_tokens",
    schemaError: wrapperError ?? schemaError,
    actualCall: call ?? null,
    expectedArgs: sample.expectedArgs,
  };
}

async function appendDiscovery(
  history: Message[],
  response: any,
  surface: RunToolSurface,
  target: string,
): Promise<Message[]> {
  const call = singleCall(response);
  if (!call || call.name !== "ToolSearch" || call.input?.query !== `select:${target}`)
    throw new Error("Discovery did not return the exact requested ToolSearch call");
  const result = await toolSearchTool(call.input, {
    cwd: "/synthetic-complex-schema-probe",
    runToolSurface: surface,
  } as ToolContext);
  if (!surface.isCallable(target)) throw new Error("Discovery did not load the target schema");
  return [
    ...history,
    { role: "assistant", content: response.content },
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: call.id,
          content: typeof result === "string" ? result : result.contentBlocks,
        },
      ],
    },
  ];
}

function appendReceipt(history: Message[], response: any, next: string): Message[] {
  const call = singleCall(response);
  if (!call) throw new Error("Cannot continue a cache trajectory without one completed tool call");
  return [
    ...history,
    { role: "assistant", content: response.content },
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: call.id,
          content: "SIMULATED RECEIPT ONLY. No target tool was executed.",
        },
        { type: "text", text: next },
      ],
    },
  ];
}

export function summarize(report: any) {
  const accuracy = Object.fromEntries(
    MODES.map((mode) => {
      const rows = report.records.filter(
        (record: any) => record.mode === mode && record.kind === "accuracy",
      );
      return [
        mode,
        {
          attempts: rows.length,
          correct: rows.filter((r: any) => r.score.correct).length,
          schemaValid: rows.filter((r: any) => r.score.schemaValid).length,
          semanticValid: rows.filter((r: any) => r.score.semanticValid).length,
          truncated: rows.filter((r: any) => r.score.truncated).length,
        },
      ];
    }),
  );
  const cache = Object.fromEntries(
    MODES.map((mode) => {
      const rows = report.records.filter((record: any) => record.mode === mode);
      const checks = rows
        .filter((record: any) =>
          [
            "cache-resume",
            "cache-cold-control",
            "cache-restored",
            "cache-append-discover",
            "cache-append-call",
            "cache-append-receipt",
          ].includes(record.kind),
        )
        .map((record: any) => ({
          stage: record.stage,
          kind: record.kind,
          ...record.usage,
          hitFraction: record.usage.cacheRead / record.usage.totalInput,
          ...(typeof record.previousInputTokens === "number"
            ? {
                previousInputTokens: record.previousInputTokens,
                // Permit a small uncached transport tail, never an entire historical turn.
                priorPrefixCovered: record.usage.cacheRead >= record.previousInputTokens - 32,
              }
            : {}),
        }));
      const restored = checks.find((r: any) => r.kind === "cache-restored");
      const cold = checks.find((r: any) => r.kind === "cache-cold-control");
      const repeatRows = rows.filter((r: any) => r.kind === "accuracy" && r.repetition === 1);
      const warm =
        mode === "eager"
          ? repeatRows.at(-1)?.usage
          : checks.find((r: any) => r.kind === "cache-resume");
      return [
        mode,
        {
          exactRepeatReads: repeatRows.map((r: any) => ({
            caseId: r.caseId,
            read: r.usage.cacheRead,
            total: r.usage.totalInput,
            hitFraction: r.usage.cacheRead / r.usage.totalInput,
          })),
          exactRepeatsWarm:
            repeatRows.length === complexSchemaCases.length &&
            repeatRows.every((r: any) => r.usage.cacheRead / r.usage.totalInput >= 0.95),
          checks,
          warmFullPrefix: !!warm && warm.cacheRead > 0 && warm.cacheRead / warm.totalInput >= 0.95,
          negativeControlCold: !!cold && cold.cacheRead === 0 && cold.cacheWrite > 0,
          restoredWarm: !!restored && restored.cacheRead / restored.totalInput >= 0.95,
          historyPrefixCovered:
            mode === "eager"
              ? null
              : checks.filter((r: any) => r.kind.startsWith("cache-append-")).length === 3 &&
                checks
                  .filter((r: any) => r.kind.startsWith("cache-append-"))
                  .every((r: any) => r.priorPrefixCovered),
        },
      ];
    }),
  );
  return { accuracy, cache };
}

export function parseOptions(args: string[]) {
  const options = { live: false, authorized: false, budgetUsd: 2, outputDir: "", ledgerPath: "" };
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const flag = args[i]!;
    if (seen.has(flag)) throw new Error("Duplicate option");
    seen.add(flag);
    if (flag === "--live") options.live = true;
    else if (flag === "--authorized-paid-probe") options.authorized = true;
    else if (["--budget-usd", "--output-dir", "--ledger-path"].includes(flag)) {
      const value = args[++i];
      if (!value || value.startsWith("--")) throw new Error("Missing option value");
      if (flag === "--budget-usd") options.budgetUsd = Number(value);
      else if (flag === "--output-dir") options.outputDir = value;
      else options.ledgerPath = value;
    } else throw new Error("Unknown option");
  }
  if (options.budgetUsd !== 2) throw new Error("This authorization has a cumulative USD 2 ceiling");
  if (
    options.live &&
    (!options.authorized || !seen.has("--budget-usd") || !options.outputDir || !options.ledgerPath)
  )
    throw new Error(
      "Live execution requires authorization, cumulative budget, evidence directory and shared ledger",
    );
  return options;
}

export async function runStudy(options: ReturnType<typeof parseOptions>, dependencies: any = {}) {
  const checked = parseOptions(
    options.live
      ? [
          "--live",
          ...(options.authorized ? ["--authorized-paid-probe"] : []),
          "--budget-usd",
          String(options.budgetUsd),
          "--output-dir",
          options.outputDir,
          "--ledger-path",
          options.ledgerPath,
        ]
      : [],
  );
  for (const definition of complexSchemaDefinitions)
    if (validateToolInputSchemaStrict(definition.inputSchema))
      throw new Error("Invalid fixture schema");
  const report: any = {
    version: 1,
    mode: options.live ? "live" : "dry-run",
    endpoint: LIMITS.endpoint,
    model: LIMITS.model,
    plannedRequests: PLANNED_REQUESTS,
    modes: MODES,
    uniqueCases: complexSchemaCases.length,
    repetitions: 2,
    cacheCriteria: {
      exactRepeatMinimumHitFraction: 0.95,
      appendedHistoryMaximumUncachedPriorTokens: 32,
      negativeControl: "Zero read tokens and positive write tokens after changing the first tool",
    },
    cumulativeBudgetUsd: 2,
    priorCostUsd: LIMITS.priorCostNanoUsd / 1e9,
    remainingBeforeRunUsd: (LIMITS.budgetNanoUsd - LIMITS.priorCostNanoUsd) / 1e9,
    method:
      "Matched post-discovery argument construction; 8 prose tasks twice per arm, independent histories without previous answers. Native and CallTool use actual model-generated ToolSearch turns and the production ToolSearch result/projector. Target tools never execute. Provider pin/rate filters are probe-only controls. Portable arm forces call-tool projection on the same thinking-disabled Messages route.",
    limitations:
      "Eight unique synthetic cases with two samples each are a conformance comparison, not a production accuracy estimate. Repeated trials are correlated; no latency or statistical equivalence claim. No direct Anthropic or thinking-mode test.",
    sources: [
      "https://openrouter.ai/anthropic/claude-sonnet-5",
      "https://openrouter.ai/docs/cookbook/administration/usage-accounting",
      "https://openrouter.ai/docs/guides/best-practices/prompt-caching",
      "https://openrouter.ai/docs/guides/routing/provider-selection#max-price",
    ],
    records: [],
    prefixAssertions: [],
  };
  if (!checked.live) {
    report.templateBodies = MODES.map((mode) =>
      bodyFor(
        mode,
        surfaceFor(mode),
        [text("Do not call a tool. Reply READY.")],
        0,
        "offline-template",
      ),
    );
    return report;
  }
  const output = await prepareEvidence(checked.outputDir);
  const ledger = await openBudgetLedger(checked.ledgerPath, { priorEvidencePath: PRIOR_EVIDENCE });
  let key = "";
  const save = async (name: string, value: unknown) => {
    let data = JSON.stringify(
      value,
      (field, item) =>
        /^(authorization|x-api-key|apiKey|api_key|cookie|set-cookie)$/i.test(field)
          ? "[REDACTED]"
          : item,
      2,
    );
    if (key) data = data.split(key).join("[REDACTED]");
    await writeFile(resolve(output, name), data + "\n", { flag: "wx", mode: 0o600 });
  };
  const runId = randomUUID();
  const startedAt = Date.now();
  const transport = dependencies.transport ?? sendExact;
  const send = async (mode: Mode, kind: string, body: any, extra: Record<string, unknown> = {}) => {
    const stage = `${String(report.records.length + 1).padStart(2, "0")}-${mode}-${kind}`;
    const reservation = await ledger.reserve(stage, body, runId);
    const record: any = {
      stage,
      mode,
      kind,
      ...extra,
      reservation,
      startedAt: new Date().toISOString(),
      requestHash: hash(body),
      toolsHash: hash(body.tools),
      systemHash: hash(body.system),
      messagesHash: hash(withoutMarkers(body.messages)),
      usage: null,
    };
    report.records.push(record);
    await save(stage + "-request.json", {
      endpoint: LIMITS.endpoint,
      headers: { Authorization: "[REDACTED]", "anthropic-version": "2023-06-01" },
      body,
    });
    const start = Date.now();
    const result = await transport({ endpoint: LIMITS.endpoint, key, body });
    await save(stage + "-response.json", result);
    if (result.status < 200 || result.status >= 300)
      throw new Error(`HTTP ${result.status}; stopping without retry`);
    let response;
    try {
      response = JSON.parse(result.rawBody);
    } catch {
      // Parser diagnostics may quote only part of a credential echoed by an error page.
      throw new Error("Non-JSON endpoint response; stopping without retry");
    }
    await ledger.settle(reservation.id, response);
    record.elapsedMs = Date.now() - start;
    record.usage = usageEvidence(response);
    record.response = response;
    dependencies.onProgress?.({
      stage,
      cumulativeExposureUsd: ledger.snapshot().exposureNanoUsd / 1e9,
      usage: record.usage,
    });
    return { response, record };
  };
  try {
    await save("plan.json", {
      ...report,
      runId,
      startedAt: new Date(startedAt).toISOString(),
      ledgerPath: checked.ledgerPath,
    });
    key = await (dependencies.loadCredential ?? loadCredential)();
    for (const mode of MODES) {
      const nonce = `${runId}-${mode}`;
      const branches = new Map<string, { surface: RunToolSurface; history: Message[] }>();
      let first: any;
      let last: any;
      for (const sample of complexSchemaCases) {
        let branch = branches.get(sample.toolName);
        if (!branch) {
          const surface = surfaceFor(mode);
          let history: Message[] = [];
          if (mode !== "eager") {
            history = [
              text(
                `Only discover ${sample.toolName}: call ToolSearch with query select:${sample.toolName}, then await the next instruction.`,
              ),
            ];
            const initial = bodyFor(mode, surface, history, 0, nonce);
            const found = await send(mode, "discovery", initial, { toolName: sample.toolName });
            history = await appendDiscovery(history, found.response, surface, sample.toolName);
            const loaded = bodyFor(mode, surface, history, history.length, nonce);
            assertAppendOnly(initial, loaded);
            report.prefixAssertions.push({
              mode,
              stage: "discovery",
              toolName: sample.toolName,
              passed: true,
            });
          }
          branch = { surface, history };
          branches.set(sample.toolName, branch);
        }
        const history = [
          ...branch.history,
          text(`Use ${sample.toolName} for this task. ${sample.instruction}`),
        ];
        const body = bodyFor(mode, branch.surface, history, branch.history.length, nonce);
        for (let repetition = 0; repetition < 2; repetition++) {
          const result = await send(mode, "accuracy", body, { caseId: sample.id, repetition });
          result.record.score = scoreResponse(mode, sample, result.response);
          const state = {
            ...result,
            body,
            history,
            surface: branch.surface,
            stableCount: branch.history.length,
          };
          first ??= state;
          last = state;
        }
      }
      if (mode === "eager") {
        await send(mode, "cache-cold-control", coldControl(last.body, nonce + "-cold"));
        await send(mode, "cache-restored", last.body);
        continue;
      }
      const nextSample = complexSchemaCases.find(
        (sample) => sample.toolName !== complexSchemaCases[0]!.toolName,
      )!;
      let history = appendReceipt(
        first.history,
        first.response,
        `Only discover ${nextSample.toolName}: call ToolSearch with query select:${nextSample.toolName}, then await the next instruction.`,
      );
      let previousBody = first.body;
      let body = bodyFor(mode, first.surface, history, first.history.length, nonce);
      assertAppendOnly(previousBody, body);
      const discovered = await send(mode, "cache-append-discover", body, {
        previousInputTokens: first.record.usage.totalInput,
      });
      previousBody = body;
      history = await appendDiscovery(
        history,
        discovered.response,
        first.surface,
        nextSample.toolName,
      );
      history.push(text(`Use ${nextSample.toolName} for this task. ${nextSample.instruction}`));
      const stableCount = history.length - 1;
      body = bodyFor(mode, first.surface, history, stableCount, nonce);
      assertAppendOnly(previousBody, body);
      const invoked = await send(mode, "cache-append-call", body, {
        previousInputTokens: discovered.record.usage.totalInput,
      });
      invoked.record.score = scoreResponse(mode, nextSample, invoked.response);
      previousBody = body;
      history = appendReceipt(history, invoked.response, "Do not call any tool. Reply DONE only.");
      body = bodyFor(mode, first.surface, history, stableCount, nonce);
      assertAppendOnly(previousBody, body);
      const completed = await send(mode, "cache-append-receipt", body, {
        previousInputTokens: invoked.record.usage.totalInput,
      });
      if (
        completed.response.stop_reason !== "end_turn" ||
        completed.response.content.some((part: any) => part.type === "tool_use")
      )
        throw new Error("Cache completion unexpectedly requested a tool");
      report.prefixAssertions.push({ mode, stage: "append-two-tools", passed: true });
      first.surface.recordRequest(Date.parse(completed.record.startedAt));
      await save(mode + "-resume-state.json", {
        selection: first.surface.getSelection(),
        history,
        stableCount,
      });
      const persisted = JSON.parse(
        await readFile(resolve(output, mode + "-resume-state.json"), "utf8"),
      );
      const restoredSurface = surfaceFor(mode, persisted.selection);
      restoredSurface.updateCatalog([
        discoveryDefinition(mode),
        callToolDef,
        ...complexSchemaDefinitions.map((def) => ({
          ...def,
          description: "Changed current registry description; warm schema stays frozen.",
        })),
      ]);
      const restored = bodyFor(
        mode,
        restoredSurface,
        persisted.history,
        persisted.stableCount,
        nonce,
      );
      if (JSON.stringify(restored) !== JSON.stringify(body))
        throw new Error("Warm disk restoration changed request bytes");
      report.prefixAssertions.push({ mode, stage: "disk-resume-exact-body", passed: true });
      await send(mode, "cache-resume", restored);
      await send(mode, "cache-cold-control", coldControl(restored, nonce + "-cold"));
      await send(mode, "cache-restored", restored);
    }
    report.status = "completed";
  } catch (error) {
    report.status = "stopped";
    report.reason = String((error as Error)?.message ?? "Probe stopped")
      .split(key || "__no_key__")
      .join("[REDACTED]");
  } finally {
    report.finishedAt = new Date().toISOString();
    report.ledger = ledger.snapshot();
    report.summary = summarize({
      ...report,
      records: report.records.filter(
        (record: any) => record.usage && (record.kind !== "accuracy" || record.score),
      ),
    });
    report.acceptance = {
      allPrimaryCallsCorrect: MODES.every(
        (mode) =>
          report.summary.accuracy[mode].attempts === 16 &&
          report.summary.accuracy[mode].correct === 16,
      ),
      cacheControlsPass: MODES.every((mode) => {
        const cache = report.summary.cache[mode];
        return (
          cache.exactRepeatsWarm &&
          cache.warmFullPrefix &&
          cache.negativeControlCold &&
          cache.restoredWarm &&
          (mode === "eager" || cache.historyPrefixCovered)
        );
      }),
    };
    try {
      await save("evidence.json", report);
    } finally {
      await ledger.close();
    }
  }
  return report;
}

export async function main(args = process.argv.slice(2)) {
  const report = await runStudy(parseOptions(args), {
    onProgress: (entry: unknown) => process.stdout.write(JSON.stringify(entry) + "\n"),
  });
  console.log(
    JSON.stringify(
      {
        mode: report.mode,
        status: report.status,
        plannedRequests: report.plannedRequests,
        records: report.records.length,
        cumulativeBudgetUsd: report.cumulativeBudgetUsd,
        priorCostUsd: report.priorCostUsd,
        remainingBeforeRunUsd: report.remainingBeforeRunUsd,
        summary: report.summary,
        reason: report.reason,
      },
      null,
      2,
    ),
  );
  if (report.status === "stopped") process.exitCode = 1;
  return report;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => {
    console.error("Probe setup failed; no automatic retry.");
    process.exitCode = 1;
  });
}
