import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager, UsageLedger, type SettingsManager } from "@cjhyy/code-shell-core";
import { ModelTraceStore } from "@cjhyy/code-shell-core/internal";
import {
  ExternalRuntimeMemory,
  resolveExternalMemoryModel,
  type ExternalMemorySnapshot,
} from "./external-runtime-memory.js";

type Settings = ReturnType<SettingsManager["get"]>;
let directory: string;
let storage: string;
const jobs: ExternalRuntimeMemory[] = [];
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "external-memory-"));
  storage = join(directory, "sessions");
});
afterEach(async () => {
  await Promise.all(jobs.splice(0).map((job) => job.dispose()));
  rmSync(directory, { recursive: true, force: true });
});
function settings(): Settings {
  return {
    memories: { autoExtract: false },
    defaults: { text: "primary" },
    modelConnections: ["primary", "aux", "extract"].map((id) => ({
      id,
      catalogId: "openai",
      tag: "text",
      model: `fixture-${id}`,
      credentialId: "fixture",
    })),
    credentials: [{ id: "fixture", catalogId: "openai", apiKey: "fixture-key" }],
  } as Settings;
}
function snapshot(fields: Partial<ExternalMemorySnapshot> = {}): ExternalMemorySnapshot {
  const sessionId = fields.sessionId ?? "memory-session";
  const sessions = new SessionManager(storage);
  if (!sessions.exists(sessionId))
    sessions.create(directory, "fixture-chat", "claude-code", sessionId, null, "desktop");
  const ledger = new UsageLedger({ storageDir: join(storage, ".usage-ledger") });
  sessions.updateSessionState(sessionId, { costState: ledger.sessionState(sessionId, storage) });
  return {
    sessionId,
    runId: "completed-run",
    cwd: directory,
    kind: "claude-code",
    model: "claude-actual-model",
    messages: Array.from({ length: 8 }, (_, index) => ({
      role: index % 2 ? "assistant" : "user",
      content: `turn ${index}`,
    })),
    assertCurrent() {},
    ...fields,
  };
}
function summaryPath(id = "memory-session") {
  return join(directory, "session-memories", `${id}.json`);
}
const answer = JSON.stringify({
  summary: "latest verified outcome",
  keyTopics: [],
  decisions: ["keep source scope"],
});

test("follow current never resolves the unrelated default API; explicit extraction overrides aux", () => {
  const config = settings();
  expect(resolveExternalMemoryModel(config)).toEqual({ kind: "current-runtime" });
  config.defaults!.auxText = "aux";
  expect(resolveExternalMemoryModel(config)).toMatchObject({
    kind: "api",
    config: { model: "fixture-aux" },
  });
  config.memories!.extractionModel = "extract";
  expect(resolveExternalMemoryModel(config)).toMatchObject({
    kind: "api",
    config: { model: "fixture-extract" },
  });
  config.memories!.extractionModel = "missing";
  expect(() => resolveExternalMemoryModel(config)).toThrow("unavailable");
});

test("Claude follow uses the captured CLI model and persists a scoped summary", async () => {
  const captured: Array<{ model?: string; systemPrompt: string }> = [];
  const errors: unknown[] = [];
  const memory = new ExternalRuntimeMemory({
    storageDir: storage,
    readSettings: settings,
    infer: async (request) => {
      captured.push(request);
      return { text: answer };
    },
    onError: (_snapshot, error) => errors.push(error),
  });
  jobs.push(memory);
  memory.schedule(snapshot());
  await memory.idle("memory-session");
  expect(errors).toEqual([]);
  expect(captured).toHaveLength(1);
  expect(captured[0]!.model).toBe("claude-actual-model");
  expect(captured[0]).toMatchObject({ cwd: directory });
  expect(JSON.parse(readFileSync(summaryPath(), "utf8")).summary).toBe("latest verified outcome");
  const traces = new ModelTraceStore({ storageDir: join(storage, ".model-traces") }).list();
  expect(traces.items[0]).toMatchObject({
    sessionId: "memory-session",
    runId: "completed-run",
    provider: "claude",
    model: "claude-actual-model",
    purpose: "aux_summary",
    estimatedCostUsd: null,
  });
  const ledger = new UsageLedger({ storageDir: join(storage, ".usage-ledger") });
  expect(
    ledger.adoptSession(
      "memory-session",
      new SessionManager(storage).readSessionState("memory-session")!.costState,
      storage,
    ),
  ).toBe(true);
  expect(ledger.summary({ scope: "session", sessionId: "memory-session" }, storage)).toMatchObject({
    requests: 1,
    unknownCostRequests: 1,
    unknownUsageRequests: 1,
  });
});

test("unsupported Codex follow is visible and never calls Claude or a default API", async () => {
  let calls = 0;
  const errors: unknown[] = [];
  const memory = new ExternalRuntimeMemory({
    storageDir: storage,
    readSettings: settings,
    infer: async () => {
      calls++;
      return { text: answer };
    },
    createClient: async () => {
      calls++;
      throw new Error("unexpected API");
    },
    onError: (_snapshot, error) => errors.push(error),
  });
  jobs.push(memory);
  memory.schedule(snapshot({ kind: "codex" }));
  await memory.idle("memory-session");
  expect(calls).toBe(0);
  expect(String(errors[0])).toContain("tool-free");
  const store = new ModelTraceStore({ storageDir: join(storage, ".model-traces") });
  expect(store.events("completed-run")[0]).toMatchObject({
    kind: "lifecycle",
    status: "failed",
    sessionId: "memory-session",
  });
  expect(store.list().total).toBe(0);
  expect(existsSync(summaryPath())).toBe(false);
});

test("Codex can use an explicit API auxiliary connection with tools disabled", async () => {
  const config = settings();
  config.defaults!.auxText = "aux";
  const received: unknown[] = [];
  const errors: unknown[] = [];
  const memory = new ExternalRuntimeMemory({
    storageDir: storage,
    readSettings: () => config,
    createClient: (async (selected) => {
      expect(selected.model).toBe("fixture-aux");
      return {
        createMessage: async (request: unknown) => {
          received.push(request);
          return { text: answer, toolCalls: [] };
        },
      };
    }) as any,
    infer: async () => {
      throw new Error("unexpected CLI");
    },
    onError: (_snapshot, error) => errors.push(error),
  });
  jobs.push(memory);
  memory.schedule(snapshot({ kind: "codex" }));
  await memory.idle("memory-session");
  expect(errors).toEqual([]);
  expect(received).toHaveLength(1);
  expect(received[0]).toMatchObject({ tools: [], maxTokens: 3072 });
  expect(existsSync(summaryPath())).toBe(true);
});

test.each(["length", "max_tokens"])("CLI %s output cannot replace memory", async (stopReason) => {
  const memory = new ExternalRuntimeMemory({
    storageDir: storage,
    readSettings: settings,
    infer: async () => ({ text: answer, stopReason }),
    onError() {},
  });
  jobs.push(memory);
  memory.schedule(snapshot());
  await memory.idle("memory-session");
  expect(existsSync(summaryPath())).toBe(false);
});

test("a model-setting change during inference prevents a late summary write", async () => {
  const config = settings();
  const memory = new ExternalRuntimeMemory({
    storageDir: storage,
    readSettings: () => config,
    infer: async () => {
      config.defaults!.auxText = "aux";
      return { text: answer };
    },
    onError() {},
  });
  jobs.push(memory);
  memory.schedule(snapshot());
  await memory.idle("memory-session");
  expect(existsSync(summaryPath())).toBe(false);
});

test("superseded jobs release the queue even when old transport ignores abort", async () => {
  let release!: () => void;
  let started!: () => void;
  const firstStarted = new Promise<void>((resolve) => (started = resolve));
  let oldGuard!: () => void;
  const runs: string[] = [];
  const memory = new ExternalRuntimeMemory({
    run: async (input, _signal, guard) => {
      runs.push(input.runId);
      if (input.runId === "old") {
        oldGuard = guard;
        started();
        await new Promise<void>((resolve) => (release = resolve));
      }
      guard();
    },
  });
  jobs.push(memory);
  const input = snapshot({ runId: "old" });
  memory.schedule(input);
  await firstStarted;
  memory.schedule({ ...input, runId: "discarded" });
  memory.schedule({ ...input, runId: "latest" });
  await memory.idle(input.sessionId);
  expect(runs).toEqual(["old", "latest"]);
  expect(() => oldGuard()).toThrow();
  release();
  await Promise.resolve();
});

test("dispose cancels pending maintenance without waiting for a wedged provider", async () => {
  let started!: () => void;
  const pending = new Promise<void>((resolve) => (started = resolve));
  let release!: () => void;
  const memory = new ExternalRuntimeMemory({
    run: async () => {
      started();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    },
  });
  jobs.push(memory);
  memory.schedule(snapshot());
  await pending;
  await memory.dispose();
  release();
});

test("dispose waits for abort-driven child cleanup before the host exits", async () => {
  let started!: () => void;
  const pending = new Promise<void>((resolve) => (started = resolve));
  let cleaned = false;
  const memory = new ExternalRuntimeMemory({
    run: async (_snapshot, signal) => {
      started();
      await new Promise<void>((resolve) =>
        signal.addEventListener(
          "abort",
          () => {
            setTimeout(() => {
              cleaned = true;
              resolve();
            }, 10);
          },
          { once: true },
        ),
      );
    },
  });
  jobs.push(memory);
  memory.schedule(snapshot());
  await pending;
  await memory.dispose();
  expect(cleaned).toBe(true);
});
