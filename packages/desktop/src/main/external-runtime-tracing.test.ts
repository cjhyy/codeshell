import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelTraceStore } from "@cjhyy/code-shell-core/internal";
import { startExternalRuntimeTrace } from "./external-runtime-tracing.js";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
function fixture(captureContent = true) {
  const storageDir = mkdtempSync(join(tmpdir(), "external-model-trace-"));
  directories.push(storageDir);
  const store = new ModelTraceStore({ storageDir });
  store.setConfig({ captureContent });
  const trace = startExternalRuntimeTrace({
    storageDir,
    sessionId: "session-cli",
    runId: "run-cli",
    workspacePath: "/workspace/cli",
    kind: "codex",
    model: "selected-cli-model",
    input: { text: "submitted request", attachments: [{ path: "/workspace/cli/image.png" }] },
    developerInstructions: "known host instructions",
    initialContext: "known session context",
  })!;
  return { store, trace };
}

describe("external CLI model history", () => {
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

  test("revoking content capture clears captured payload on final update; disabled tracing writes nothing", () => {
    const { store, trace } = fixture();
    trace.observe({ type: "text_delta", text: "PRIVATE_RESPONSE" });
    store.setConfig({ captureContent: false });
    trace.finish();
    const record = store.get(store.list().items[0]!.id)!;
    expect(record.input).toBeUndefined();
    expect(record.output).toBeUndefined();
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
    trace.finish();
    const record = store.get(store.list().items[0]!.id)!;
    expect(record.output!.text).toContain("before pause");
    expect(record.output!.text).toContain("after pause");
    expect(record.output!.text).toContain("[Content capture paused]");
    expect(JSON.stringify(record)).not.toContain("NEVER_CAPTURE_PAUSED_RESPONSE");
  });
});
