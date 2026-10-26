import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HookRegistry, ToolRegistry } from "@cjhyy/code-shell-core";
import { createSessionToolHost, type SessionToolHost } from "@cjhyy/code-shell-core/extension";
import { ModelTraceStore } from "@cjhyy/code-shell-core/internal";
import { startExternalRuntimeTrace } from "./external-runtime-tracing.js";

const directories: string[] = [];
const hosts: SessionToolHost[] = [];
type SessionToolHostRunContext = NonNullable<
  ReturnType<NonNullable<Parameters<typeof createSessionToolHost>[0]["captureRunContext"]>>
>;
afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.dispose()));
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
function fixture(
  captureContent = true,
  source?: string,
  sharedStorage?: string,
  runId = "run-cli",
) {
  const storageDir = sharedStorage ?? mkdtempSync(join(tmpdir(), "external-model-trace-"));
  if (!sharedStorage) directories.push(storageDir);
  const store = new ModelTraceStore({ storageDir });
  store.setConfig({ captureContent });
  const trace = startExternalRuntimeTrace({
    storageDir,
    source,
    sessionId: "session-cli",
    runId,
    workspacePath: "/workspace/cli",
    kind: "codex",
    model: "selected-cli-model",
    input: { text: "submitted request", attachments: [{ path: "/workspace/cli/image.png" }] },
    developerInstructions: "known host instructions",
    initialContext: "known session context",
  })!;
  return { store, trace };
}

function tracedHost(
  captureRunContext: () => SessionToolHostRunContext,
  currentTrace: () => ReturnType<typeof fixture>["trace"],
) {
  const hooks = new HookRegistry();
  const registry = new ToolRegistry({ builtinTools: [] });
  registry.registerTool(
    {
      name: "HostProbe",
      description: "Synthetic Host tool with a sensitive result",
      source: "builtin",
      permissionDefault: "allow",
      inputSchema: { type: "object", properties: { value: { type: "string" } } },
    },
    () => ({
      ok: true,
      result: "NEVER_CAPTURE_HOST_SECRET",
      sensitive: true,
      transcriptResult: "[Host result hidden]",
    }),
  );
  const host = createSessionToolHost({
    businessSessionId: "session-cli",
    cwd: process.cwd(),
    registry,
    hooks,
    permissionMode: "default",
    presetRules: [{ tool: "HostProbe", decision: "allow" }],
    projectTrusted: false,
    planMode: false,
    exposure: { mode: "allowlist", toolNames: new Set(["HostProbe"]) },
    visibility: { cwd: process.cwd(), host: "desktop", isSubAgent: false },
    captureRunContext,
    getStreamCallback: () => {
      const trace = currentTrace();
      return (event) => trace.observe(event);
    },
  });
  hosts.push(host);
  return { host, hooks };
}

function tracedRun(trace: ReturnType<typeof fixture>["trace"]): SessionToolHostRunContext {
  return {
    operations: undefined,
    originClientMessageId: "fixture-user",
    signal: new AbortController().signal,
    assertCurrent() {},
    runToolWithTrace: (id, operation) => trace.runHostTool(id, operation),
  };
}

describe("external CLI model history", () => {
  test("Host executor owns exactly one attributed span and native tools keep their own spans", async () => {
    const { store, trace } = fixture();
    const { host, hooks } = tracedHost(
      () => tracedRun(trace),
      () => trace,
    );
    hooks.register("pre_tool_use", () => ({ updatedInput: { value: "sanitized" } }));
    const result = await host.execute({
      id: "host-call",
      name: "HostProbe",
      input: { value: "original" },
    });
    expect(result.result).toBe("NEVER_CAPTURE_HOST_SECRET");
    // A native tool with the same name is not the explicitly claimed Host call.
    trace.observe({
      type: "tool_use_start",
      toolCall: { id: "third-party-call", toolName: "HostProbe", args: { source: "native" } },
    });
    trace.observe({
      type: "tool_result",
      result: { id: "third-party-call", toolName: "HostProbe", result: "third-party output" },
    });
    trace.observe({
      type: "tool_use_start",
      toolCall: {
        id: "third-party-mcp",
        toolName: "mcpToolCall",
        args: { server: "third-party", tool: "Read" },
      },
    });
    trace.observe({
      type: "tool_result",
      result: { id: "third-party-mcp", toolName: "mcpToolCall", result: "MCP output" },
    });
    trace.finish();
    const events = store.events("run-cli");
    expect(events).toHaveLength(3);
    expect(
      events.find((event) => (event.input as { toolCallId?: string })?.toolCallId === "host-call"),
    ).toMatchObject({
      sessionId: "session-cli",
      runId: "run-cli",
      workspacePath: "/workspace/cli",
      input: { toolCallId: "host-call", args: { value: "sanitized" } },
      status: "completed",
      outputState: "redacted",
      output: "[Host result hidden]",
    });
    expect(
      events.find((event) => (event.input as { source?: string })?.source === "native"),
    ).toMatchObject({
      status: "completed",
      output: "third-party output",
    });
    expect(events.find((event) => event.name === "mcpToolCall")).toMatchObject({
      input: { server: "third-party", tool: "Read" },
      status: "completed",
      output: "MCP output",
    });
    expect(JSON.stringify(events)).not.toContain("NEVER_CAPTURE_HOST_SECRET");
  });

  test("a Host call keeps its captured trace after finish and a replacement submission", async () => {
    const first = fixture();
    const second = fixture(true, undefined, first.store.storageDir, "run-next");
    let active = first.trace;
    let current = true;
    let entered!: () => void;
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => (entered = resolve));
    const barrier = new Promise<void>((resolve) => (release = resolve));
    const { host, hooks } = tracedHost(
      () => {
        const run = tracedRun(active);
        if (active === first.trace)
          run.assertCurrent = () => {
            if (!current) throw new Error("Old submission ended");
          };
        return run;
      },
      () => active,
    );
    hooks.register("pre_tool_use", async (context) => {
      if (context.data.toolCallId === "old-host-call") {
        entered();
        await barrier;
      }
      return {};
    });
    const old = host.execute({ id: "old-host-call", name: "HostProbe", input: {} });
    await waiting;
    first.trace.finish("aborted_streaming");
    current = false;
    active = second.trace;
    expect(
      (await host.execute({ id: "next-host-call", name: "HostProbe", input: {} })).isError,
    ).toBe(false);
    release();
    expect((await old).isError).toBe(true);
    second.trace.finish();
    expect(first.store.events("run-cli")).toHaveLength(1);
    expect(first.store.events("run-cli")[0]).toMatchObject({
      runId: "run-cli",
      status: "failed",
      input: { toolCallId: "old-host-call" },
      error: "Bound tool authority or input changed before execution.",
    });
    expect(second.store.events("run-next")).toHaveLength(1);
    expect(second.store.events("run-next")[0]).toMatchObject({
      runId: "run-next",
      status: "completed",
      input: { toolCallId: "next-host-call" },
    });
  });

  test("one physical CLI submission retains its exact owner and finite coverage, with correlated visible tool events", () => {
    const { store, trace } = fixture();
    const initial = store.list().items[0]!;
    expect(initial.status).toBe("running");
    trace.observe({ type: "text_delta", text: "hello " });
    trace.observe({ type: "text_delta", text: "world" });
    trace.observe({ type: "thinking_delta", text: "visible reasoning" });
    trace.observe({
      type: "tool_use_start",
      toolCall: { id: "read-1", toolName: "Read", args: {} },
    });
    trace.observe({
      type: "tool_use_args_delta",
      toolCallId: "read-1",
      args: { file: "README.md" },
    });
    trace.observe({
      type: "tool_result",
      result: {
        id: "read-1",
        toolName: "Read",
        result: "NEVER_CAPTURE_PRIVATE_TOOL_RESULT",
        sensitive: true,
        transcriptResult: "[Sensitive result hidden]",
      },
    });
    trace.observe({ type: "usage_update", promptTokens: 12, completionTokens: 3 });
    trace.observe({ type: "turn_complete", reason: "completed" });
    trace.finish();
    trace.finish("model_error");
    expect(store.list().total).toBe(1);
    const record = store.get(initial.id)!;
    expect(record).toMatchObject({
      traceId: "run-cli",
      runId: "run-cli",
      sessionId: "session-cli",
      workspacePath: "/workspace/cli",
      source: "desktop-codex-cli",
      status: "completed",
      input: {
        messages: [{ role: "user", content: "submitted request" }],
        parameters: {
          developerInstructions: "known host instructions",
          sessionInitialContext: "known session context",
        },
      },
      output: { text: "hello world", thinking: "visible reasoning", stopReason: "completed" },
    });
    expect(record.attempts.map((attempt) => attempt.coverage)).toEqual(["external-cli-input"]);
    expect(record.usage).toBeUndefined();
    const events = store.events(record.traceId);
    expect(events).toHaveLength(2);
    expect(events.find((event) => event.kind === "tool")).toMatchObject({
      traceId: "run-cli",
      workspacePath: "/workspace/cli",
      status: "completed",
      input: { file: "README.md" },
      output: "[Sensitive result hidden]",
    });
    expect(JSON.stringify(events)).not.toContain("NEVER_CAPTURE_PRIVATE_TOOL_RESULT");
  });

  test("metadata mode omits CLI inputs, responses, errors and event bodies even if capture is enabled mid-turn", () => {
    const { store, trace } = fixture(false);
    trace.observe({ type: "text_delta", text: "PRIVATE_RESPONSE" });
    trace.observe({ type: "error", error: "PRIVATE_ERROR" });
    trace.observe({ type: "usage_update", promptTokens: 8, completionTokens: 2 });
    store.setConfig({ captureContent: true });
    trace.finish();
    const record = store.get(store.list().items[0]!.id)!;
    expect(record).toMatchObject({
      status: "failed",
      inputState: "not-recorded",
      outputState: "not-recorded",
    });
    const persisted = JSON.stringify([record, store.events(record.traceId)]);
    expect(persisted).not.toContain("PRIVATE_");
    expect(persisted).not.toContain("submitted request");
    expect(persisted).not.toContain("known host instructions");
  });

  test("revoking content capture preserves previously saved input but stops final output; disabled tracing writes nothing", () => {
    const { store, trace } = fixture();
    trace.observe({ type: "text_delta", text: "PRIVATE_RESPONSE" });
    store.setConfig({ captureContent: false });
    trace.finish();
    const record = store.get(store.list().items[0]!.id)!;
    expect(record.input?.messages).toEqual([{ role: "user", content: "submitted request" }]);
    expect(record.output).toBeUndefined();
    expect(JSON.stringify(record)).not.toContain("PRIVATE_RESPONSE");
    store.setConfig({ enabled: false });
    expect(
      startExternalRuntimeTrace({
        storageDir: store.storageDir,
        sessionId: "session-disabled",
        runId: "run-disabled",
        workspacePath: "/workspace/cli",
        kind: "claude-code",
        input: { text: "must not persist" },
        developerInstructions: "must not persist",
      }),
    ).toBeUndefined();
    expect(store.list().total).toBe(1);
  });

  test("output accumulation remains bounded and interruption does not leave a running tool span", () => {
    const { store, trace } = fixture();
    for (let index = 0; index < 16; index++)
      trace.observe({ type: "text_delta", text: "x".repeat(32 * 1024) });
    trace.observe({
      type: "tool_use_start",
      toolCall: { id: "pending", toolName: "Bash", args: { command: "sleep 10" } },
    });
    trace.finish("aborted_streaming");
    const record = store.get(store.list().items[0]!.id)!;
    expect(record.status).toBe("cancelled");
    expect(record.outputState).toBe("truncated");
    expect(record.output!.text!.length).toBeLessThan(70_000);
    expect(store.events(record.traceId)[0]!.status).toBe("cancelled");
  });

  test("content emitted while capture is paused cannot appear when capture is enabled again", () => {
    const { store, trace } = fixture();
    trace.observe({ type: "text_delta", text: "before pause" });
    store.setConfig({ captureContent: false });
    trace.observe({ type: "text_delta", text: "NEVER_CAPTURE_PAUSED_RESPONSE" });
    store.setConfig({ captureContent: true });
    trace.observe({ type: "text_delta", text: "after pause" });
    trace.observe({
      type: "tool_use_start",
      toolCall: { id: "late-tool", toolName: "Read", args: { path: "NEVER_CAPTURE_LATE_TOOL" } },
    });
    trace.observe({
      type: "tool_result",
      result: { id: "late-tool", toolName: "Read", result: "NEVER_CAPTURE_LATE_RESULT" },
    });
    trace.finish();
    const record = store.get(store.list().items[0]!.id)!;
    expect(record.outputState).toBe("not-recorded");
    expect(JSON.stringify(record)).not.toContain("after pause");
    expect(JSON.stringify(record)).not.toContain("NEVER_CAPTURE_PAUSED_RESPONSE");
    const events = store.events(record.traceId);
    expect(events.find((event) => event.kind === "tool")).toMatchObject({
      inputState: "not-recorded",
      outputState: "not-recorded",
    });
    expect(JSON.stringify(events)).not.toContain("NEVER_CAPTURE_LATE_");
  });
});

test("Host Panel submissions retain Panel source through external CLI calls without widening scope", () => {
  const f = fixture(true, "panel:design-studio");
  f.trace.finish();
  expect(f.store.list().items[0]).toMatchObject({
    source: "panel:design-studio",
    workspacePath: "/workspace/cli",
    sessionId: "session-cli",
  });
  const invalid = fixture(true, "../../forged");
  invalid.trace.finish();
  expect(invalid.store.list().items[0]?.source).toBe("desktop-codex-cli");
});
