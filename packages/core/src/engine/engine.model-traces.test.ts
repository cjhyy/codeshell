import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine } from "./engine.js";
import { initialToolsFixtureModule } from "./initial-tools-preset.fixture.js";
import { LLMClientBase } from "../llm/client-base.js";
import { registerProvider } from "../llm/client-factory.js";
import type { CreateMessageOptions } from "../llm/types.js";
import type { LLMResponse, Message, ToolDefinition } from "../types.js";
import { currentUsageOwner } from "../cost-ledger/context.js";
import { clearModelTracingConfiguration, configureModelTracing } from "../model-traces/context.js";
import type { ModelTraceStore } from "../model-traces/store.js";

const provider = "engine-model-traces-fixture";
const toolCallId = "engine-trace-probe-call";
const toolOutput = "TRACE_ENGINE_TOOL_OUTPUT";
const calls: Array<{
  purpose: string;
  systemPrompt: string;
  messages: Message[];
  tools: ToolDefinition[];
}> = [];

class TraceFixtureClient extends LLMClientBase {
  protected initClient(): void {}
  async createMessage(options: CreateMessageOptions): Promise<LLMResponse> {
    const purpose = options.usagePurpose ?? currentUsageOwner()?.purpose ?? "unattributed";
    calls.push({
      purpose,
      systemPrompt: options.systemPrompt,
      messages: structuredClone(options.messages),
      tools: structuredClone(options.tools ?? []),
    });
    const useTool =
      purpose === "main" &&
      options.tools?.some((tool) => tool.name === "TraceProbe") &&
      !JSON.stringify(options.messages).includes(toolOutput);
    const usage = { promptTokens: 20, completionTokens: 5, totalTokens: 25 };
    this.recordUsage(usage, options);
    return {
      text: useTool
        ? ""
        : purpose === "main"
          ? "TRACE_ENGINE_ANSWER"
          : "A compact fixture summary.",
      toolCalls: useTool
        ? [{ id: toolCallId, toolName: "TraceProbe", args: { value: "assembled" } }]
        : [],
      stopReason: useTool ? "tool_use" : "stop",
      usage,
    };
  }
}
registerProvider(provider, TraceFixtureClient);

let root: string;
let traces: ModelTraceStore;
const engines: Engine[] = [];
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "engine-model-traces-"));
  traces = configureModelTracing({ storageDir: join(root, "traces"), source: "engine-fixture" });
});
afterEach(async () => {
  for (const engine of engines.splice(0).reverse()) await engine.dispose();
  clearModelTracingConfiguration();
  calls.length = 0;
  rmSync(root, { recursive: true, force: true });
});

function engine(withTool = false): Engine {
  const value = new Engine({
    llm: { provider, providerKind: "openai", model: "gpt-4o", apiKey: "synthetic-fixture" },
    cwd: root,
    sessionStorageDir: join(root, "sessions"),
    settingsScope: "isolated",
    headless: true,
    maxTurns: 3,
    maxContextTokens: 128_000,
    permissionMode: "bypassPermissions",
    clientDefaults: {
      fetch: (() => {
        throw new Error("Engine trace fixture must never make a network request");
      }) as typeof fetch,
    },
    modules: [initialToolsFixtureModule(withTool ? ["TraceProbe"] : [])],
    behaviorProfiles: [
      {
        id: "trace-quiet",
        disableHooks: true,
        disableInstructions: true,
        disableMemoryContext: true,
        disableMcp: true,
        disableSessionTitle: true,
      },
    ],
  });
  value.getHookRegistry().clear();
  if (withTool)
    value.registerCustomTool(
      {
        name: "TraceProbe",
        description: "Return a deterministic fixture result",
        inputSchema: {
          type: "object",
          properties: { value: { type: "string" } },
          required: ["value"],
        },
        source: "builtin",
        permissionDefault: "allow",
        pathPolicyExempt: true,
      },
      async () => toolOutput,
    );
  engines.push(value);
  return value;
}

test("real Engine runs retain assembled model inputs, separate execution IDs and exact tool parents without replay duplicates", async () => {
  const firstEngine = engine(true);
  // Engine's durable output wrapper enables tool summaries even without a UI
  // listener. Wait for this auxiliary call explicitly: the dynamic import may
  // settle before or after run() returns depending on earlier tests.
  let finishToolSummary!: () => void;
  const toolSummaryFinished = new Promise<void>((resolve) => {
    finishToolSummary = resolve;
  });
  const first = await firstEngine.run("TRACE_FIRST_REQUEST", {
    sessionId: "trace-session",
    clientMessageId: "trace-input-first",
    behaviorMode: "trace-quiet",
    onStream: (event) => {
      if (event.type === "tool_summary") finishToolSummary();
    },
  });
  expect(first.reason).toBe("completed");
  await toolSummaryFinished;
  const firstRows = traces.list({ sessionId: "trace-session", traceId: first.runId }).items;
  expect(firstRows.map((row) => row.purpose).sort()).toEqual(["main", "main", "tool_summary"]);
  expect(firstRows.every((row) => row.runId === first.runId && row.workspacePath === root)).toBe(
    true,
  );
  const firstRecords = firstRows
    .filter((row) => row.purpose === "main")
    .map((row) => traces.get(row.id)!);
  const mainCalls = calls.filter((call) => call.purpose === "main");
  expect(mainCalls).toHaveLength(2);
  const toolModel = firstRecords.find((record) => record.output?.toolCalls?.length)!;
  expect(toolModel.input?.systemPrompt).toBe(mainCalls[0].systemPrompt);
  expect(toolModel.input?.systemPrompt).toContain(`Working directory: ${root}`);
  expect(toolModel.input?.systemPrompt).toContain("# Available Tools");
  expect(toolModel.input?.messages).toEqual(mainCalls[0].messages);
  expect(toolModel.input?.tools).toEqual(mainCalls[0].tools);
  expect(JSON.stringify(toolModel.input?.messages)).toContain("TRACE_FIRST_REQUEST");
  expect(toolModel.input?.tools.some((tool: any) => tool.name === "TraceProbe")).toBe(true);
  expect(toolModel.attempts[0].coverage).toBe("logical-input");
  const following = firstRecords.find((record) => record.id !== toolModel.id)!;
  expect(following.input?.messages).toEqual(mainCalls[1].messages);
  expect(JSON.stringify(following.input?.messages)).toContain(toolOutput);
  const summary = traces.get(firstRows.find((row) => row.purpose === "tool_summary")!.id)!;
  const summaryCalls = calls.filter((call) => call.purpose === "tool_summary");
  expect(summaryCalls).toHaveLength(1);
  expect(summary.input?.systemPrompt).toBe(summaryCalls[0].systemPrompt);
  expect(summary.input?.messages).toEqual(summaryCalls[0].messages);
  expect(JSON.stringify(summary.input?.messages)).toContain("TraceProbe");
  expect(JSON.stringify(summary.input?.messages)).toContain(toolOutput);
  expect(summary.input?.tools).toEqual([]);
  const toolEvents = traces.events(first.runId).filter((event) => event.kind === "tool");
  expect(toolEvents).toHaveLength(1);
  expect(toolEvents[0]).toMatchObject({
    parentId: toolModel.id,
    sessionId: "trace-session",
    runId: first.runId,
    status: "completed",
    input: { toolCallId, args: { value: "assembled" } },
    output: toolOutput,
  });

  const second = await firstEngine.run("TRACE_SECOND_REQUEST", {
    sessionId: "trace-session",
    clientMessageId: "trace-input-second",
    behaviorMode: "trace-quiet",
  });
  expect(second.reason).toBe("completed");
  expect(second.runId).not.toBe(first.runId);
  const secondRows = traces.list({ sessionId: "trace-session", traceId: second.runId }).items;
  expect(secondRows).toHaveLength(1);
  expect(secondRows[0].runId).toBe(second.runId);
  const secondInput = traces.get(secondRows[0].id)!.input!;
  const secondCalls = calls.filter((call) => call.purpose === "main").slice(mainCalls.length);
  expect(secondCalls).toHaveLength(1);
  expect(secondInput.systemPrompt).toBe(secondCalls[0].systemPrompt);
  expect(secondInput.messages).toEqual(secondCalls[0].messages);
  expect(JSON.stringify(secondInput.messages)).toContain("TRACE_FIRST_REQUEST");
  expect(JSON.stringify(secondInput.messages)).toContain("TRACE_SECOND_REQUEST");

  const beforeReplay = traces.list().total;
  const eventCount = traces.events(second.runId).length;
  const modelCalls = calls.length;
  await firstEngine.dispose();
  const restarted = engine(true);
  const replay = await restarted.run("TRACE_SECOND_REQUEST", {
    sessionId: "trace-session",
    clientMessageId: "trace-input-second",
    behaviorMode: "trace-quiet",
  });
  expect(replay.runId).toBe(second.runId);
  expect(calls).toHaveLength(modelCalls);
  expect(traces.list().total).toBe(beforeReplay);
  expect(traces.events(second.runId)).toHaveLength(eventCount);
  const originalReplay = await restarted.run("TRACE_FIRST_REQUEST", {
    sessionId: "trace-session",
    clientMessageId: "trace-input-first",
    behaviorMode: "trace-quiet",
  });
  expect(originalReplay.runId).toBe(first.runId);
  expect(calls).toHaveLength(modelCalls);
  expect(traces.list().total).toBe(beforeReplay);
  expect(traces.events(first.runId).filter((event) => event.kind === "tool")).toHaveLength(1);
});

test("an ephemeral Panel-like Engine run records its assembled Prompt by default with its fixed source", async () => {
  const value = engine();
  const manager = value.getSessionManager();
  manager.create(root, "gpt-4o", provider, "panel-source");
  manager.fork("panel-source", { targetSessionId: "panel-temporary", ephemeral: true });
  const result = await value.run("PANEL_DEFAULT_PROMPT", {
    sessionId: "panel-temporary",
    clientMessageId: "panel-default-input",
    behaviorMode: "trace-quiet",
    modelTraceSource: "panel-app:fixture/summarize",
  });
  expect(result.reason).toBe("completed");
  const rows = traces.list({ sessionId: "panel-temporary", traceId: result.runId }).items;
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    source: "panel-app:fixture/summarize",
    workspacePath: root,
    runId: result.runId,
    purpose: "main",
    inputState: "recorded",
    outputState: "recorded",
  });
  const recorded = traces.get(rows[0].id)!;
  expect(recorded.input?.systemPrompt).toBe(calls[0].systemPrompt);
  expect(recorded.input?.messages).toEqual(calls[0].messages);
  expect(JSON.stringify(recorded.input?.messages)).toContain("PANEL_DEFAULT_PROMPT");
  expect(recorded.output?.text).toBe("TRACE_ENGINE_ANSWER");
  expect(existsSync(join(root, "sessions", "panel-temporary"))).toBe(false);
});

test("ephemeral Engine runs and out-of-run summary/compact helpers respect explicit persistence opt-out", async () => {
  traces.setConfig({ includeEphemeral: false });
  const value = engine();
  const manager = value.getSessionManager();
  const parent = manager.create(root, "gpt-4o", provider, "trace-source");
  for (let index = 0; index < 16; index++) {
    parent.transcript.appendMessage("user", `private round ${index} ${"context ".repeat(300)}`);
    parent.transcript.appendMessage(
      "assistant",
      `private response ${index} ${"answer ".repeat(300)}`,
    );
  }
  const runEphemeral = async (sessionId: string) => {
    const fork = manager.fork("trace-source", { targetSessionId: sessionId, ephemeral: true });
    expect(fork.bundle.state.ephemeral).toBe(true);
    const result = await value.run("PRIVATE_EPHEMERAL_REQUEST", {
      sessionId,
      clientMessageId: `${sessionId}-input`,
      behaviorMode: "trace-quiet",
    });
    expect(result.reason).toBe("completed");
    const packaged = await value.summarizeContextPackage(
      [{ role: "user", content: "PRIVATE_CONTEXT_PACKAGE" }],
      undefined,
      sessionId,
    );
    expect(packaged.summary).toBe("A compact fixture summary.");
    const compacted = await value.forceCompact(sessionId);
    expect(compacted.after).toBeLessThan(compacted.before);
    expect(existsSync(join(root, "sessions", sessionId))).toBe(false);
    return result;
  };

  const hidden = await runEphemeral("trace-ephemeral-private");
  expect(calls.map((call) => call.purpose)).toEqual(["main", "context_package", "manual_compact"]);
  expect(traces.list().total).toBe(0);
  expect(traces.events(hidden.runId)).toEqual([]);
  expect(existsSync(join(root, "traces", "records"))).toBe(false);
  expect(existsSync(join(root, "traces", "events"))).toBe(false);

  traces.setConfig({ includeEphemeral: true });
  const visible = await runEphemeral("trace-ephemeral-opted-in");
  const rows = traces.list({ sessionId: "trace-ephemeral-opted-in" }).items;
  expect(rows).toHaveLength(3);
  expect(rows.map((row) => row.purpose).sort()).toEqual([
    "context_package",
    "main",
    "manual_compact",
  ]);
  expect(rows.every((row) => row.workspacePath === root && row.source === "engine-fixture")).toBe(
    true,
  );
  const main = rows.find((row) => row.purpose === "main")!;
  expect(main.traceId).toBe(visible.runId);
  expect(main.runId).toBe(visible.runId);
  for (const helper of rows.filter((row) => row.purpose !== "main")) {
    expect(helper.runId).toBeUndefined();
    expect(helper.traceId).toBe(helper.id);
    expect(traces.get(helper.id)?.inputState).toBe("recorded");
  }
  expect(traces.list({ sessionId: "trace-ephemeral-private" }).total).toBe(0);
  expect(traces.events(visible.runId).some((event) => event.kind === "lifecycle")).toBe(true);
});
