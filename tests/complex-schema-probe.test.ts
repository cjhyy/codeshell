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
function fixture(transform = (_index: number, response: any, _body: any) => response) {
  const requests: any[] = [];
  const modesSeen = new Set<string>();
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
      const cold =
        !modesSeen.has(mode) || body.tools[0].description.startsWith("Cold-control prefix ");
      modesSeen.add(mode);
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
            cache_read_input_tokens: cold ? 0 : 5000,
            cache_creation_input_tokens: cold ? 5000 : 0,
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

test("all 70 injected requests retain 48 matched accuracy trials and production discovery projections", async () => {
  const options = await liveOptions();
  const transport = fixture();
  const report = await runStudy(options, transport);
  expect(report.reason).toBeUndefined();
  expect(report.status).toBe("completed");
  expect(transport.credentialReads).toBe(1);
  expect(transport.requests).toHaveLength(PLANNED_REQUESTS);
  expect(report.records).toHaveLength(70);
  expect(report.acceptance).toEqual({ allPrimaryCallsCorrect: true, cacheControlsPass: true });
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
    });
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
      expect(
        resultParts(firstAccuracy).some((part) =>
          part.text?.includes("Call tools loaded through native references"),
        ),
      ).toBe(true);
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
    expect(report.acceptance).toEqual({ allPrimaryCallsCorrect: false, cacheControlsPass: true });
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
