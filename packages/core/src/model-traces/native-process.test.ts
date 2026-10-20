import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createNativeModelTraceCollector,
  configureModelTracing,
  clearModelTracingConfiguration,
  withModelTraceContext,
} from "./context.js";
import type { ModelTraceStore } from "./store.js";
import { bashTool } from "../tool-system/builtin/bash.js";
import type { ToolContext } from "../tool-system/context.js";
import { BackgroundShellManager } from "../runtime/background-shell.js";

let root: string, store: ModelTraceStore;
const managers: BackgroundShellManager[] = [];
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "native-model-trace-"));
  store = configureModelTracing({ storageDir: join(root, "traces"), source: "fixture" });
});
afterEach(async () => {
  for (const manager of managers.splice(0)) await manager.killAll();
  clearModelTracingConfiguration();
  rmSync(root, { recursive: true, force: true });
});
const start = {
  version: 1,
  type: "model_trace",
  phase: "start",
  callId: "call-1",
  provider: "fixture",
  model: "voice",
  purpose: "tts",
  input: {
    systemPrompt: "",
    messages: [{ role: "user", content: "实际配音文字" }],
    parameters: { authorization: "PRIVATE_AUTH" },
  },
};
const done = {
  version: 1,
  type: "model_trace",
  phase: "finish",
  callId: "call-1",
  status: "completed",
  output: { data: { durationSeconds: 2, format: "wav" } },
};
const quoted = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;
const scope = (fn: () => any) =>
  withModelTraceContext(
    { workspacePath: root, sessionId: "native-session", runId: "native-run" },
    fn,
  );
const emit = (
  collector: NonNullable<ReturnType<typeof createNativeModelTraceCollector>>,
  message: unknown,
) => collector.data(JSON.stringify(message) + "\n");

test("malformed child inputs and token/output shapes cannot enter a renderable trace", () => {
  const collector = scope(() => createNativeModelTraceCollector({ workspacePath: root }))!;
  emit(collector, { ...start, input: { messages: "malformed" } });
  emit(collector, { ...start, inputState: "not-recorded" });
  expect(store.list().total).toBe(0);
  emit(collector, start);
  emit(collector, {
    ...done,
    output: { text: { invalid: true }, toolCalls: "malformed", data: { safe: true } },
    usage: { promptTokens: null, completionTokens: 1, totalTokens: 1 },
  });
  const saved = store.get(store.list().items[0].id)!;
  expect(saved.status).toBe("completed");
  expect(saved.output?.text).toBeUndefined();
  expect(saved.output?.toolCalls).toBeUndefined();
  expect(saved.output?.data).toEqual({ safe: true });
  expect(saved.usage).toBeUndefined();
});

test("native reports keep Host scope, redact credentials, and close an unfinished call on process cancellation", () => {
  const collector = scope(() => createNativeModelTraceCollector({ workspacePath: root }))!;
  emit(collector, { ...start, storageDir: "/attacker", workspacePath: "/attacker" });
  expect(store.list().total).toBe(0);
  emit(collector, start);
  collector.finish("cancelled");
  const saved = store.get(store.list().items[0].id)!;
  expect(saved).toMatchObject({
    workspacePath: root,
    sessionId: "native-session",
    runId: "native-run",
    status: "cancelled",
  });
  expect(saved.attempts[0].coverage).toBe("logical-input");
  expect(JSON.stringify(saved)).not.toContain("PRIVATE_AUTH");
  expect(saved.input?.messages).toEqual(start.input.messages);
});

test("an existing native invocation cannot replay final content after capture was disabled and reopened", () => {
  const collector = scope(() => createNativeModelTraceCollector({ workspacePath: root }))!;
  emit(collector, start);
  store.setConfig({ captureContent: false });
  store.setConfig({ captureContent: true });
  emit(collector, { ...done, output: { text: "PRIVATE_CUMULATIVE_RESULT" } });
  collector.finish("failed");
  const saved = store.get(store.list().items[0].id)!;
  expect(saved.status).toBe("completed");
  expect(saved.outputState).toBe("not-recorded");
  expect(JSON.stringify(saved)).not.toContain("PRIVATE_CUMULATIVE_RESULT");
});

test("real Agent shell native inference uses a separate fd and preserves its ordinary stdout", async () => {
  const path = join(root, "tool.mjs");
  writeFileSync(
    path,
    `import { writeSync } from 'node:fs'; const fd=Number(process.env.CODESHELL_MODEL_TRACE_FD); writeSync(fd, ${JSON.stringify(JSON.stringify(start) + "\n")}); writeSync(fd, ${JSON.stringify(JSON.stringify(done) + "\n")}); console.log('ordinary-output');`,
  );
  const result = await scope(() =>
    bashTool({ command: `${quoted(process.execPath)} ${quoted(path)}` }, {
      cwd: root,
      sessionId: "native-session",
    } as ToolContext),
  );
  expect(result.ok).toBe(true);
  expect(result.result).toContain("ordinary-output");
  expect(result.result).not.toContain("model_trace");
  const saved = store.get(store.list().items[0].id)!;
  expect(saved.status).toBe("completed");
  expect(saved.output?.data).toEqual(done.output.data);
});

test("background Agent shells retain their original model trace owner after the submit returns", async () => {
  const manager = new BackgroundShellManager();
  managers.push(manager);
  const path = join(root, "background.mjs");
  writeFileSync(
    path,
    `import { writeSync } from 'node:fs'; const fd=Number(process.env.CODESHELL_MODEL_TRACE_FD); writeSync(fd, ${JSON.stringify(JSON.stringify(start) + "\n")}); setTimeout(()=>{writeSync(fd, ${JSON.stringify(JSON.stringify(done) + "\n")}); console.log('background-output');},20);`,
  );
  const result = await scope(() =>
    bashTool({ command: `${quoted(process.execPath)} ${quoted(path)}`, run_in_background: true }, {
      cwd: root,
      sessionId: "native-session",
      backgroundShells: manager,
    } as ToolContext),
  );
  expect(result.ok).toBe(true);
  const deadline = Date.now() + 3000;
  while (store.list().items[0]?.status !== "completed") {
    if (Date.now() > deadline) throw new Error("Background native trace timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(store.get(store.list().items[0].id)).toMatchObject({
    workspacePath: root,
    sessionId: "native-session",
    runId: "native-run",
  });
});
