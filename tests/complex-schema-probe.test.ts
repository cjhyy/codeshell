import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolContext } from "../packages/core/src/tool-system/context.js";
import { installFixtureNetworkGuard } from "./helpers/network-fixture.js";

const network = installFixtureNetworkGuard(); // No network origins, including during imports.
const {
  MODES,
  PLANNED_REQUESTS,
  assertAppendOnly,
  bodyFor,
  coldControl,
  discoveryDefinition,
  parseOptions,
  runStudy,
  scoreResponse,
  summarize,
  surfaceFor,
  withoutMarkers,
} = await import("../docs/todo/prompt-cache-probes-20261111/complex-schema-probe-20261112.ts");
const { complexSchemaCases, complexSchemaDefinitions } =
  await import("../docs/todo/prompt-cache-probes-20261111/complex-schema-cases-20261112.mjs");
const { LIMITS } =
  await import("../docs/todo/prompt-cache-probes-20261111/complex-probe-budget-20261112.mjs");
const { initializeRunToolSurface } = await import("../packages/core/src/engine/run-tooling.js");
const { toolSearchToolDef } =
  await import("../packages/core/src/tool-system/builtin/tool-search.js");
const { toolDiscoverySchemaText } =
  await import("../packages/core/src/utils/tool-schema-discovery.js");
const { VERSION } = await import("../packages/core/src/version.js");

type Mode = (typeof MODES)[number];
const directories: string[] = [];
const KEY = "fixture-only-key-never-read-operator-credentials";
afterAll(() => network.restore());
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});
async function liveOptions() {
  const parent = await mkdtemp(join(tmpdir(), "complex-schema-probe-test-"));
  directories.push(parent);
  return parseOptions([
    "--live",
    "--authorized-paid-probe",
    "--budget-usd",
    "2",
    "--output-dir",
    join(parent, "evidence"),
    "--ledger-path",
    join(parent, "budget.json"),
  ]);
}

function latestInstruction(body: any): string {
  const message = body.messages.findLast((item: any) => item.role === "user");
  if (typeof message?.content === "string") return message.content;
  return message?.content.findLast((part: any) => part.type === "text")?.text ?? "";
}
function modeFor(body: any): Mode {
  const match = body.system[0].text.match(/, mode (eager|native|call-tool)\./);
  if (!match) throw new Error("Missing fixture arm");
  return match[1];
}
function callResponse(mode: Mode, sample: any, args = structuredClone(sample.expectedArgs)) {
  return {
    stop_reason: "tool_use",
    content: [
      {
        type: "tool_use",
        id: "fixture_target",
        name: mode === "call-tool" ? "CallTool" : sample.toolName,
        input: mode === "call-tool" ? { name: sample.toolName, args } : args,
      },
    ],
  };
}
// Deliberately synthetic counts: model prefix matching, not a real tokenizer.
function staticPrefixTokens(body: any): number {
  return Math.ceil(JSON.stringify([body.tools, body.system]).length / 4);
}
function fixture(transform = (_index: number, response: any, _body: any) => response) {
  const requests: any[] = [];
  const cachedPrefixes = new Map<string, { messages: string[]; tokens: number }[]>();
  let credentialReads = 0;
  return {
    requests,
    get credentialReads() {
      return credentialReads;
    },
    loadCredential: async () => {
      credentialReads++;
      return KEY;
    },
    transport: async (request: any) => {
      expect(request.endpoint).toBe(LIMITS.endpoint);
      expect(request.key).toBe(KEY);
      const { body } = request;
      const index = requests.length;
      requests.push(structuredClone(body));
      const mode = modeFor(body);
      const instruction = latestInstruction(body);
      const discovery = instruction.match(
        /Only discover (\w+): call ToolSearch with query select:\1,/,
      );
      const sample = complexSchemaCases.find(
        (entry: any) => instruction === `Use ${entry.toolName} for this task. ${entry.instruction}`,
      );
      let answer: any;
      if (discovery)
        answer = {
          stop_reason: "tool_use",
          content: [
            {
              type: "tool_use",
              id: `fixture_search_${index}`,
              name: "ToolSearch",
              input: { query: `select:${discovery[1]}` },
            },
          ],
        };
      else if (sample) {
        answer = callResponse(mode, sample);
        answer.content[0].id = `fixture_target_${index}`;
      } else if (instruction === "Do not call any tool. Reply DONE only.")
        answer = { stop_reason: "end_turn", content: [{ type: "text", text: "DONE" }] };
      else throw new Error("Unexpected fixture instruction: " + instruction);
      const staticPrefix = JSON.stringify([body.tools, body.system]);
      const staticTokens = staticPrefixTokens(body);
      const messages = (withoutMarkers(body.messages) as any[]).map((message) =>
        JSON.stringify(message),
      );
      const cacheableTokens =
        staticTokens +
        messages.reduce((total, message) => total + Math.ceil(message.length / 4), 0);
      const cached = cachedPrefixes.get(staticPrefix) ?? [];
      let read = cached.length ? staticTokens : 0;
      for (const prefix of cached)
        if (
          prefix.messages.length <= messages.length &&
          prefix.messages.every((message, position) => messages[position] === message)
        )
          read = Math.max(read, prefix.tokens);
      cached.push({ messages, tokens: cacheableTokens });
      cachedPrefixes.set(staticPrefix, cached);
      const response = transform(
        index,
        {
          type: "message",
          id: `msg_fixture_${index}`,
          model: LIMITS.model,
          provider: "Anthropic",
          ...answer,
          usage: {
            input_tokens: 20,
            cache_read_input_tokens: read,
            cache_creation_input_tokens: cacheableTokens - read,
            output_tokens: 100,
            cost: 0.001,
          },
        },
        body,
      );
      return { status: 200, headers: { "set-cookie": KEY }, rawBody: JSON.stringify(response) };
    },
  };
}
function resultParts(body: any): any[] {
  return body.messages
    .flatMap((message: any) => (Array.isArray(message.content) ? message.content : []))
    .filter((part: any) => part.type === "tool_result")
    .flatMap((part: any) =>
      typeof part.content === "string" ? [{ type: "text", text: part.content }] : part.content,
    );
}

test("dry run validates all arms without credentials, transport, evidence writes or network", async () => {
  let credentialReads = 0;
  let requests = 0;
  const report = await runStudy(parseOptions([]), {
    loadCredential: () => {
      credentialReads++;
      throw new Error("No dry-run credential reads");
    },
    transport: () => {
      requests++;
      throw new Error("No dry-run transport");
    },
  });
  expect(credentialReads).toBe(0);
  expect(requests).toBe(0);
  expect(report.mode).toBe("dry-run");
  expect(report.records).toEqual([]);
  expect(report.plannedRequests).toBe(70);
  expect(report.templateBodies).toHaveLength(3);
  expect(report.remainingBeforeRunUsd).toBeCloseTo(1.9494754, 9);
});

test.each([
  ["--live"],
  ["--live", "--authorized-paid-probe", "--budget-usd", "2"],
  ["--budget-usd", "3"],
  ["--budget-usd", "NaN"],
  ["--endpoint", "https://example.com"],
  ["--modes", "native,native"],
  ["--modes", "native,unknown"],
  ["--modes", ""],
  ["--pure-eager-control", "--modes", "eager"],
  ["--live", "--live"],
])("incomplete or changed live authorization is rejected: %j", (...args) => {
  expect(() => parseOptions(args)).toThrow();
});

test("native search definition matches the actual production initializer", () => {
  const ctx = {
    cwd: "/fixture",
    llmConfig: {
      provider: "anthropic",
      providerKind: "openrouter",
      model: LIMITS.model,
      baseUrl: "https://openrouter.ai/api/v1",
      reasoning: { mode: "off" },
    },
  } as ToolContext;
  initializeRunToolSurface(ctx, [], () => [toolSearchToolDef, ...complexSchemaDefinitions]);
  expect(discoveryDefinition("native")).toEqual(ctx.runToolSurface!.getDefinition("ToolSearch")!);
  expect(discoveryDefinition("call-tool")).toEqual(toolSearchToolDef);
});

test("explicit remaining arms avoid repeating completed eager requests", async () => {
  const dry = await runStudy(parseOptions(["--modes", "native,call-tool"]));
  expect(dry.modes).toEqual(["native", "call-tool"]);
  expect(dry.plannedRequests).toBe(52);
  expect(dry.templateBodies).toHaveLength(2);
  const injected = fixture();
  const report = await runStudy(
    { ...(await liveOptions()), modes: ["native", "call-tool"] },
    injected,
  );
  expect(report.records).toHaveLength(52);
  expect(report.records.every((row: any) => row.mode !== "eager")).toBe(true);
  expect(report.summary.accuracy.eager.attempts).toBe(0);
  expect(report.acceptance).toEqual({
    allPrimaryCallsCorrect: true,
    auxiliaryTargetCallsCorrect: true,
    cacheControlsPass: true,
  });
});

test("post-hoc pure eager control removes only discovery tools and samples each original task once", async () => {
  const dry = await runStudy(parseOptions(["--pure-eager-control"]));
  expect(dry.modes).toEqual(["eager"]);
  expect(dry.plannedRequests).toBe(8);
  expect(dry.repetitions).toBe(1);
  const injected = fixture();
  const report = await runStudy(
    { ...(await liveOptions()), modes: ["eager"], pureEagerControl: true },
    injected,
  );
  expect(report.status).toBe("completed");
  expect(report.records).toHaveLength(8);
  expect(report.records.map((row: any) => row.caseId)).toEqual(
    complexSchemaCases.map((sample: any) => sample.id),
  );
  expect(report.records.every((row: any) => row.kind === "accuracy" && row.repetition === 0)).toBe(
    true,
  );
  for (const body of injected.requests) {
    expect(body.tools).toHaveLength(4);
    expect(
      body.tools.some((tool: any) => tool.name === "CallTool" || tool.name === "ToolSearch"),
    ).toBe(false);
    expect(body.tools.filter((tool: any) => tool.cache_control)).toHaveLength(1);
    expect(body.tools.at(-1).cache_control).toEqual({ type: "ephemeral" });
    for (const tool of body.tools) {
      expect(tool.input_schema).toEqual(
        complexSchemaDefinitions.find((definition: any) => definition.name === tool.name)!
          .inputSchema,
      );
    }
  }
  expect(report.acceptance).toEqual({
    allPrimaryCallsCorrect: true,
    auxiliaryTargetCallsCorrect: null,
    cacheControlsPass: null,
  });
});

test("all 70 injected requests retain 48 matched accuracy trials and production discovery projections", async () => {
  const options = await liveOptions();
  const transport = fixture();
  const report = await runStudy(options, transport);
  expect(report.reason).toBeUndefined();
  expect(report.status).toBe("completed");
  expect(transport.credentialReads).toBe(1);
  expect(transport.requests).toHaveLength(PLANNED_REQUESTS);
  expect(report.records).toHaveLength(70);
  expect(report.acceptance).toEqual({
    allPrimaryCallsCorrect: true,
    auxiliaryTargetCallsCorrect: true,
    cacheControlsPass: true,
  });
  expect(report.summary.auxiliaryAccuracy).toEqual({ attempts: 2, correct: 2 });
  expect(report.records.filter((record: any) => record.kind === "accuracy")).toHaveLength(48);
  for (const mode of MODES) {
    expect(report.summary.accuracy[mode]).toEqual({
      attempts: 16,
      correct: 16,
      schemaValid: 16,
      semanticValid: 16,
      truncated: 0,
    });
    expect(report.summary.cache[mode]).toMatchObject({
      warmFullPrefix: true,
      negativeControlCold: true,
      restoredWarm: true,
      historyPrefixCovered: mode === "eager" ? null : true,
      exactRepeatsWarm: true,
      historyCacheExpired: false,
    });
    const appends = report.summary.cache[mode].checks.filter((check: any) =>
      check.kind.startsWith("cache-append-"),
    );
    expect(appends).toHaveLength(mode === "eager" ? 0 : 3);
    for (const check of appends) {
      const index = report.records.findIndex((record: any) => record.stage === check.stage);
      const previous =
        check.kind === "cache-append-discover"
          ? report.records.find((record: any) => record.mode === mode && record.kind === "accuracy")
          : report.records[index - 1];
      expect(report.records[index].previousInputTokens).toBe(previous.usage.totalInput);
      expect(report.records[index].previousRequestCompletedAt).toBe(previous.completedAt);
      expect(check.previousInputTokens).toBe(previous.usage.totalInput);
      expect(check.previousRequestAgeMs).toBe(
        Date.parse(report.records[index].startedAt) - Date.parse(previous.completedAt),
      );
      expect(check.previousRequestAgeMs).toBeGreaterThanOrEqual(0);
      expect(check.priorPrefixWithinTtl).toBe(true);
      expect(check.priorPrefixCovered).toBe(true);
      expect(check.cacheRead).toBeGreaterThanOrEqual(previous.usage.totalInput - 32);
      expect(check.cacheRead).toBeGreaterThan(staticPrefixTokens(transport.requests[index]));
    }
    const rows = report.records.filter((record: any) => record.mode === mode);
    for (const sample of complexSchemaCases) {
      const pair = rows.filter(
        (record: any) => record.kind === "accuracy" && record.caseId === sample.id,
      );
      expect(pair.map((record: any) => record.repetition)).toEqual([0, 1]);
      expect(pair[0].requestHash).toBe(pair[1].requestHash);
      expect(pair[0].score.actualCall.input).toEqual(
        mode === "call-tool"
          ? { name: sample.toolName, args: sample.expectedArgs }
          : sample.expectedArgs,
      );
    }
    const bodies = transport.requests.filter((body) => modeFor(body) === mode);
    const warmBodies = bodies.filter(
      (body) => !body.tools[0].description.startsWith("Cold-control prefix "),
    );
    expect(new Set(warmBodies.map((body) => JSON.stringify(body.tools))).size).toBe(1);
    expect(new Set(warmBodies.map((body) => JSON.stringify(body.system))).size).toBe(1);
    const firstAccuracy =
      transport.requests[
        report.records.findIndex(
          (record: any) => record.mode === mode && record.kind === "accuracy",
        )
      ];
    if (mode === "native") {
      expect(firstAccuracy.tools.filter((tool: any) => tool.defer_loading)).toHaveLength(4);
      expect(resultParts(firstAccuracy).some((part) => part.type === "tool_reference")).toBe(true);
      // Anthropic rejects references mixed with ordinary content in one tool result.
      expect(resultParts(firstAccuracy).every((part) => part.type === "tool_reference")).toBe(true);
      expect(
        firstAccuracy.tools.find((tool: any) => tool.name === "ToolSearch").description,
      ).toContain("Invoke tools returned as native references directly");
    } else if (mode === "call-tool") {
      expect(firstAccuracy.tools.map((tool: any) => tool.name)).toEqual(["ToolSearch", "CallTool"]);
      expect(resultParts(firstAccuracy).some((part) => part.type === "tool_reference")).toBe(false);
      const portable = resultParts(firstAccuracy)
        .map((part) => part.text ?? "")
        .join("");
      expect(portable).toContain('"inputSchema":');
      expect(portable).toContain("Use CallTool to call these tools");
      expect(portable).toContain(complexSchemaCases[0].toolName);
      expect(portable).toContain(toolDiscoverySchemaText(complexSchemaDefinitions[0]));
    } else {
      expect(firstAccuracy.tools).toHaveLength(6);
      expect(firstAccuracy.tools.some((tool: any) => tool.defer_loading)).toBe(false);
    }
    for (const body of bodies) {
      const markedTools = body.tools.filter((tool: any) => tool.cache_control);
      expect(markedTools).toHaveLength(1);
      expect(markedTools[0]).toBe(body.tools.findLast((tool: any) => !tool.defer_loading));
      expect(body.tools.some((tool: any) => tool.defer_loading && tool.cache_control)).toBe(false);
      expect(body.thinking).toEqual({ type: "disabled" });
    }
    const at = (kind: string) =>
      report.records.findIndex((record: any) => record.mode === mode && record.kind === kind);
    const original =
      mode === "eager"
        ? transport.requests[at("cache-cold-control") - 1]
        : transport.requests[at("cache-append-receipt")];
    expect(transport.requests[at("cache-restored")]).toEqual(original);
    if (mode !== "eager") expect(transport.requests[at("cache-resume")]).toEqual(original);
    const cold = transport.requests[at("cache-cold-control")];
    const repaired = structuredClone(cold);
    repaired.tools[0].description = original.tools[0].description;
    expect(repaired).toEqual(original);
    expect(cold.tools[0].description).not.toBe(original.tools[0].description);
    if (mode !== "eager") {
      const persisted = JSON.parse(
        await readFile(join(options.outputDir, `${mode}-resume-state.json`), "utf8"),
      );
      expect(persisted.selection.cacheVersion).toBe(VERSION);
      expect(persisted.selection.lastRequestAt).toBe(
        Date.parse(report.records[at("cache-append-receipt")].startedAt),
      );
      const secondDiscovery = transport.requests[at("cache-append-call")];
      const loadedNames = [
        complexSchemaCases[0].toolName,
        complexSchemaCases.find(
          (sample: any) => sample.toolName !== complexSchemaCases[0].toolName,
        )!.toolName,
      ];
      const parts = resultParts(secondDiscovery);
      if (mode === "native")
        expect(
          parts.filter((part) => part.type === "tool_reference").map((part) => part.tool_name),
        ).toEqual(loadedNames);
      else
        for (const name of loadedNames)
          expect(parts.map((part) => part.text ?? "").join("")).toContain(
            toolDiscoverySchemaText(
              complexSchemaDefinitions.find((definition: any) => definition.name === name)!,
            ),
          );
    }
  }
  expect(report.prefixAssertions).toHaveLength(12);
  expect(report.prefixAssertions.every((entry: any) => entry.passed)).toBe(true);
  expect(report.ledger).toMatchObject({
    priorRequests: 7,
    newRequests: 70,
    totalRequests: 77,
    pendingRequests: 0,
  });
  expect(report.ledger.exposureNanoUsd).toBe(LIMITS.priorCostNanoUsd + 70 * 1_000_000);
  const files = await readdir(options.outputDir);
  expect(files).toHaveLength(144); // Plan/evidence, two resume states, 70 request/response pairs.
  const evidence = await readFile(join(options.outputDir, "evidence.json"), "utf8");
  expect(evidence).not.toContain(KEY);
  expect(JSON.parse(evidence).summary).toEqual(report.summary);
  expect(
    await readFile(join(options.outputDir, "01-eager-accuracy-response.json"), "utf8"),
  ).not.toContain(KEY);
}, 30_000);

test.each([968, 967])("history coverage enforces the exact 32-token allowance: read %i", (read) => {
  const records = ["discover", "call", "receipt"].map((stage) => ({
    mode: "native",
    kind: `cache-append-${stage}`,
    stage,
    previousInputTokens: 1000,
    previousRequestCompletedAt: "2026-11-12T01:00:00.000Z",
    startedAt: "2026-11-12T01:00:01.000Z",
    usage: {
      input: 20,
      cacheRead: read,
      cacheWrite: 1100 - 20 - read,
      totalInput: 1100,
      output: 10,
    },
  }));
  const cache = summarize({ records }).cache;
  expect(cache.native.historyPrefixCovered).toBe(read === 968);
  expect(cache.native.checks.every((check: any) => check.priorPrefixCovered)).toBe(read === 968);
  expect(cache.eager.historyPrefixCovered).toBeNull();
  expect(summarize({ records: records.slice(0, 2) }).cache.native.historyPrefixCovered).toBe(false);
});

test.each([299_999, 300_000, 300_001])(
  "history cache expiry is explicit at the five-minute boundary: %i ms",
  (ageMs) => {
    const completedAt = Date.parse("2026-11-12T01:00:00.000Z");
    const records = ["discover", "call", "receipt"].map((stage, index) => ({
      mode: "native",
      kind: `cache-append-${stage}`,
      stage,
      previousInputTokens: 1000,
      previousRequestCompletedAt: new Date(completedAt).toISOString(),
      startedAt: new Date(completedAt + (index === 0 ? ageMs : 1000)).toISOString(),
      usage: { input: 20, cacheRead: 1000, cacheWrite: 80, totalInput: 1100, output: 10 },
    }));
    const cache = summarize({ records }).cache.native;
    expect(cache.checks[0].previousRequestAgeMs).toBe(ageMs);
    expect(cache.checks[0].priorPrefixWithinTtl).toBe(ageMs < 300_000);
    expect(cache.checks.every((check: any) => check.priorPrefixCovered)).toBe(true);
    expect(cache.historyPrefixCovered).toBe(ageMs < 300_000);
    expect(cache.historyCacheExpired).toBe(ageMs >= 300_000);
  },
);

test("an incorrect auxiliary target call is counted separately from all 48 primary samples", async () => {
  let changed = 0;
  const injected = fixture((_index, response, body) => {
    const resultCount = body.messages
      .flatMap((message: any) => (Array.isArray(message.content) ? message.content : []))
      .filter((part: any) => part.type === "tool_result").length;
    if (modeFor(body) === "native" && resultCount === 3 && response.stop_reason === "tool_use") {
      response.content[0].input.batchId = "B-999";
      changed++;
    }
    return response;
  });
  const report = await runStudy(await liveOptions(), injected);
  expect(report.status).toBe("completed");
  expect(changed).toBe(1);
  expect(report.summary.auxiliaryAccuracy).toEqual({ attempts: 2, correct: 1 });
  for (const mode of MODES)
    expect(report.summary.accuracy[mode]).toMatchObject({ attempts: 16, correct: 16 });
  const primary = report.records.filter((record: any) => record.kind === "accuracy");
  expect(primary).toHaveLength(48);
  expect(primary.every((record: any) => record.score.correct)).toBe(true);
  expect(
    report.records.find(
      (record: any) => record.mode === "native" && record.kind === "cache-append-call",
    ).score,
  ).toMatchObject({ schemaValid: true, semanticValid: false, correct: false });
  expect(report.acceptance).toEqual({
    allPrimaryCallsCorrect: true,
    auxiliaryTargetCallsCorrect: false,
    cacheControlsPass: true,
  });
}, 30_000);

test("one missed exact repeat fails cache acceptance even when the last repeat and resume hit", async () => {
  const injected = fixture((index, response) => {
    if (index === 1) {
      response.usage.cache_creation_input_tokens += response.usage.cache_read_input_tokens;
      response.usage.cache_read_input_tokens = 0;
    }
    return response;
  });
  const report = await runStudy(await liveOptions(), injected);
  expect(report.status).toBe("completed");
  expect(report.records[1]).toMatchObject({ mode: "eager", kind: "accuracy", repetition: 1 });
  expect(report.acceptance).toEqual({
    allPrimaryCallsCorrect: true,
    auxiliaryTargetCallsCorrect: true,
    cacheControlsPass: false,
  });
  const eager = report.summary.cache.eager;
  expect(eager).toMatchObject({
    exactRepeatsWarm: false,
    warmFullPrefix: true,
    negativeControlCold: true,
    restoredWarm: true,
  });
  expect(eager.exactRepeatReads).toHaveLength(8);
  expect(eager.exactRepeatReads[0].hitFraction).toBe(0);
  expect(eager.exactRepeatReads.slice(1).every((row: any) => row.hitFraction >= 0.95)).toBe(true);
  for (const mode of ["native", "call-tool"])
    expect(report.summary.cache[mode]).toMatchObject({
      exactRepeatsWarm: true,
      historyPrefixCovered: true,
    });
}, 30_000);

test("static-prefix hits cannot pass appended-history coverage despite passing repeat controls", async () => {
  const weakened = new Set<string>();
  const injected = fixture((_index, response, body) => {
    const results = body.messages
      .flatMap((message: any) => (Array.isArray(message.content) ? message.content : []))
      .filter((part: any) => part.type === "tool_result");
    const serialized = JSON.stringify(body);
    if (
      results.length >= 2 &&
      !body.tools[0].description.startsWith("Cold-control prefix ") &&
      !weakened.has(serialized)
    ) {
      weakened.add(serialized);
      const cacheable =
        response.usage.cache_read_input_tokens + response.usage.cache_creation_input_tokens;
      response.usage.cache_read_input_tokens = staticPrefixTokens(body);
      response.usage.cache_creation_input_tokens = cacheable - staticPrefixTokens(body);
    }
    return response;
  });
  const report = await runStudy(await liveOptions(), injected);
  expect(report.status).toBe("completed");
  expect(report.records).toHaveLength(70);
  expect(weakened.size).toBe(6);
  expect(report.acceptance).toEqual({
    allPrimaryCallsCorrect: true,
    auxiliaryTargetCallsCorrect: true,
    cacheControlsPass: false,
  });
  expect(report.summary.cache.eager.historyPrefixCovered).toBeNull();
  for (const mode of ["native", "call-tool"]) {
    expect(report.summary.cache[mode]).toMatchObject({
      warmFullPrefix: true,
      negativeControlCold: true,
      restoredWarm: true,
      historyPrefixCovered: false,
      exactRepeatsWarm: true,
    });
    const checks = report.summary.cache[mode].checks.filter((check: any) =>
      check.kind.startsWith("cache-append-"),
    );
    expect(checks).toHaveLength(3);
    for (const check of checks) {
      expect(check.cacheRead).toBeGreaterThan(0);
      expect(check.cacheRead).toBeLessThan(check.previousInputTokens - 32);
      expect(check.priorPrefixCovered).toBe(false);
    }
  }
}, 30_000);

test.each(["wrong semantic value", "max_tokens"])(
  "a completed study reports failed accuracy for %s",
  async (failure) => {
    const injected = fixture((index, response) => {
      if (index === 0) {
        if (failure === "max_tokens") response.stop_reason = "max_tokens";
        else response.content[0].input.project.owner.alias = "WrongButSchemaValid";
      }
      return response;
    });
    const report = await runStudy(await liveOptions(), injected);
    expect(report.status).toBe("completed");
    expect(report.records).toHaveLength(70);
    expect(report.summary.accuracy.eager).toMatchObject({
      attempts: 16,
      correct: 15,
      truncated: failure === "max_tokens" ? 1 : 0,
    });
    expect(report.summary.accuracy.eager.schemaValid).toBe(failure === "max_tokens" ? 15 : 16);
    expect(report.acceptance).toEqual({
      allPrimaryCallsCorrect: false,
      auxiliaryTargetCallsCorrect: true,
      cacheControlsPass: true,
    });
  },
  30_000,
);

describe("accuracy scoring cannot accept wrong values or malformed calls", () => {
  const sample = complexSchemaCases[0];
  test.each(MODES)("%s checks semantics beyond schema validity", (mode) => {
    const args = structuredClone(sample.expectedArgs);
    args.project.owner.alias = "WrongButSchemaValid";
    expect(scoreResponse(mode, sample, callResponse(mode, sample, args))).toMatchObject({
      identityValid: true,
      schemaValid: true,
      semanticValid: false,
      correct: false,
    });
    expect(scoreResponse(mode, sample, callResponse(mode, sample))).toMatchObject({
      correct: true,
      truncated: false,
    });
  });
  test("CallTool validates wrapper identity and args, not only the wrapped object", () => {
    const wrongTarget = callResponse("call-tool", sample);
    wrongTarget.content[0].input.name = "AnotherTarget";
    expect(scoreResponse("call-tool", sample, wrongTarget).correct).toBe(false);
    const missingName = callResponse("call-tool", sample);
    delete missingName.content[0].input.name;
    expect(scoreResponse("call-tool", sample, missingName).schemaValid).toBe(false);
    const malformedArgs = callResponse("call-tool", sample);
    malformedArgs.content[0].input.args = "not an args object";
    expect(scoreResponse("call-tool", sample, malformedArgs).schemaValid).toBe(false);
    const wrongType = structuredClone(sample.expectedArgs);
    wrongType.execution.retry.attempts = "2";
    expect(
      scoreResponse("call-tool", sample, callResponse("call-tool", sample, wrongType)).schemaValid,
    ).toBe(false);
  });
  test.each(MODES)(
    "%s rejects truncation, multiple calls, wrong identities and unsupported blocks",
    (mode) => {
      const correct = callResponse(mode, sample);
      expect(scoreResponse(mode, sample, { ...correct, stop_reason: "max_tokens" })).toMatchObject({
        correct: false,
        truncated: true,
      });
      for (const extra of [correct.content[0], { type: "server_tool_use" }, { type: "thinking" }])
        expect(
          scoreResponse(mode, sample, { ...correct, content: [...correct.content, extra] }).correct,
        ).toBe(false);
      correct.content[0].name = "WrongTarget";
      expect(scoreResponse(mode, sample, correct).identityValid).toBe(false);
    },
  );
});

test("missing billed cost stops after one request and retains the unknown-charge reservation", async () => {
  const options = await liveOptions();
  const injected = fixture((_index, response) => {
    delete response.usage.cost;
    return response;
  });
  const report = await runStudy(options, injected);
  expect(report.status).toBe("stopped");
  expect(report.reason).toMatch(/cost/i);
  expect(injected.requests).toHaveLength(1);
  expect(report.ledger.pendingRequests).toBe(1);
  const reservation = report.ledger.records[0].reservationNanoUsd;
  expect(report.ledger.records[0].status).toBe("pending");
  expect(report.ledger.exposureNanoUsd).toBe(LIMITS.priorCostNanoUsd + reservation);
  expect(report.ledger.remainingNanoUsd).toBe(
    LIMITS.budgetNanoUsd - LIMITS.priorCostNanoUsd - reservation,
  );
  const retry = fixture();
  const retried = await runStudy(
    { ...options, outputDir: join(options.outputDir, "..", "retry-evidence") },
    retry,
  );
  expect(retried.status).toBe("stopped");
  expect(retried.reason).toMatch(/Unresolved request billing/);
  expect(retry.requests).toHaveLength(0);
  expect(retried.ledger).toEqual(report.ledger);
});

test("malformed response diagnostics never reveal credential prefixes and retain the pending bill", async () => {
  const injected = fixture();
  const produce = injected.transport;
  const prefix = KEY.slice(0, 19);
  injected.transport = async (request: any) => ({
    ...(await produce(request)),
    rawBody: `{"unexpected":"${KEY}","partial":"${prefix}`,
  });
  const report = await runStudy(await liveOptions(), injected);
  expect(report.status).toBe("stopped");
  expect(report.reason).toBe("Non-JSON endpoint response; stopping without retry");
  expect(report.reason).not.toContain(KEY);
  expect(report.reason).not.toContain(prefix);
  expect(injected.requests).toHaveLength(1);
  expect(report.ledger.pendingRequests).toBe(1);
  expect(report.ledger.records[0].status).toBe("pending");
  expect(report.ledger.exposureNanoUsd).toBe(
    LIMITS.priorCostNanoUsd + report.ledger.records[0].reservationNanoUsd,
  );
});

test("prefix assertion permits only cache-marker movement, not schema or old message edits", () => {
  const surface = surfaceFor("native");
  const messages: any[] = [{ role: "user", content: "Original fixture prompt" }];
  const before = bodyFor("native", surface, messages, 1, "fixed-nonce");
  const after = bodyFor(
    "native",
    surface,
    [...messages, { role: "assistant", content: "Append only" }],
    2,
    "fixed-nonce",
  );
  expect(() => assertAppendOnly(before, after)).not.toThrow();
  expect(withoutMarkers(after.messages[0])).toEqual(withoutMarkers(before.messages[0]));
  for (const mutate of [
    (value: any) => {
      value.tools[0].description += " changed";
    },
    (value: any) => {
      value.system[0].text += " changed";
    },
    (value: any) => {
      value.messages[0].content[0].text += " changed";
    },
  ]) {
    const changed = structuredClone(after);
    mutate(changed);
    expect(() => assertAppendOnly(before, changed)).toThrow();
  }
  const cold = coldControl(before, "distinct-control");
  expect(cold.messages).toEqual(before.messages);
  expect(cold.system).toEqual(before.system);
  expect(cold.tools[0].description).toStartWith("Cold-control prefix distinct-control. ");
  expect(() => assertAppendOnly(before, cold)).toThrow();
});
