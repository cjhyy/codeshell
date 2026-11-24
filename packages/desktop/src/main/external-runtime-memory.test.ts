import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MemoryManager,
  SessionManager,
  UsageLedger,
  type SettingsManager,
} from "@cjhyy/code-shell-core";
import { ModelTraceStore } from "@cjhyy/code-shell-core/internal";
import {
  EXTERNAL_MEMORY_CACHE_PURPOSE_PREFIX,
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
    memories: {},
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
/** Names of the memories that maintenance persisted for the fixture project. */
function savedMemories() {
  return new MemoryManager({ baseDir: directory, projectDir: directory, scope: "dream" })
    .loadAll()
    .map((memory) => memory.name);
}
const answer = JSON.stringify([
  {
    type: "project",
    scope: "project",
    name: "latest verified outcome",
    description: "keep source scope",
    content: "the outcome this maintenance run extracted",
  },
]);

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

test("Claude follow uses the captured CLI model and persists a scoped memory", async () => {
  const captured: Array<{ model?: string; systemPrompt: string }> = [];
  const errors: unknown[] = [];
  const memory = new ExternalRuntimeMemory({
    idleDelayMs: 0,
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
  expect(savedMemories()).toEqual(["latest verified outcome"]);
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
    idleDelayMs: 0,
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
  expect(savedMemories()).toEqual([]);
});

test("Codex can use an explicit API auxiliary connection with tools disabled", async () => {
  const config = settings();
  config.defaults!.auxText = "aux";
  const received: unknown[] = [];
  const errors: unknown[] = [];
  const memory = new ExternalRuntimeMemory({
    idleDelayMs: 0,
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
  expect(savedMemories()).toEqual(["latest verified outcome"]);
});

test("API memory calls send core's segmented, cacheable request in an external scope", async () => {
  const config = settings();
  config.defaults!.auxText = "aux";
  config.memories = { autoExtract: true };
  type Request = {
    messages: Array<{ role: string; content: string }>;
    promptCache?: { scopeId: string; stablePrefixMessageCount?: number };
  };
  const received: Request[] = [];
  const errors: unknown[] = [];
  const memory = new ExternalRuntimeMemory({
    idleDelayMs: 0,
    storageDir: storage,
    readSettings: () => config,
    createClient: (async () => ({
      getPromptCacheConfigIdentity: () => ({ cacheStrategy: "anthropic-explicit" }),
      createMessage: async (request: Request) => {
        received.push(request);
        return { text: "[]", toolCalls: [] };
      },
    })) as any,
    infer: async () => {
      throw new Error("unexpected CLI");
    },
    onError: (_snapshot, error) => errors.push(error),
  });
  jobs.push(memory);
  memory.schedule(snapshot({ kind: "codex" }));
  await memory.idle("memory-session");
  expect(errors).toEqual([]);
  const scopes = received.map((request) => request.promptCache?.scopeId);
  // One request per maintenance run: extraction, under the transcript-first scope.
  expect(scopes).toEqual([
    `memory-session:aux:${EXTERNAL_MEMORY_CACHE_PURPOSE_PREFIX}session-transcript`,
  ]);
  // Never the main conversation's scope, nor core's own memory scopes.
  expect(scopes).not.toContain("memory-session");
  expect(scopes).not.toContain("memory-session:aux:session-transcript");
  const extraction = received[0]!;
  expect(extraction.messages.length).toBeGreaterThan(1);
  expect(extraction.messages.every((message) => message.role === "user")).toBe(true);
  expect(extraction.promptCache!.stablePrefixMessageCount).toBe(extraction.messages.length - 1);
  // The segments join back into the single prompt the CLI route still sends.
  const joined = extraction.messages.map((message) => message.content).join("");
  expect(joined).toContain("turn 0");
  expect(joined).toContain("turn 7");
});

test("without explicit cache markers the API call keeps one complete user message", async () => {
  const config = settings();
  config.defaults!.auxText = "aux";
  const received: Array<{ messages: unknown[]; promptCache?: { scopeId: string } }> = [];
  const memory = new ExternalRuntimeMemory({
    idleDelayMs: 0,
    storageDir: storage,
    readSettings: () => config,
    createClient: (async () => ({
      createMessage: async (request: (typeof received)[number]) => {
        received.push(request);
        return { text: answer, toolCalls: [] };
      },
    })) as any,
    infer: async () => {
      throw new Error("unexpected CLI");
    },
    onError() {},
  });
  jobs.push(memory);
  memory.schedule(snapshot({ kind: "codex" }));
  await memory.idle("memory-session");
  expect(received).toHaveLength(1);
  expect(received[0]!.messages).toHaveLength(1);
  expect(received[0]!.promptCache?.scopeId).toBe(
    `memory-session:aux:${EXTERNAL_MEMORY_CACHE_PURPOSE_PREFIX}session-transcript`,
  );
});

test.each(["length", "max_tokens"])("CLI %s output cannot replace memory", async (stopReason) => {
  const memory = new ExternalRuntimeMemory({
    idleDelayMs: 0,
    storageDir: storage,
    readSettings: settings,
    infer: async () => ({ text: answer, stopReason }),
    onError() {},
  });
  jobs.push(memory);
  memory.schedule(snapshot());
  await memory.idle("memory-session");
  expect(savedMemories()).toEqual([]);
});

test("a model-setting change during inference prevents a late memory write", async () => {
  const config = settings();
  const memory = new ExternalRuntimeMemory({
    idleDelayMs: 0,
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
  expect(savedMemories()).toEqual([]);
});

test("superseded jobs release the queue even when old transport ignores abort", async () => {
  let release!: () => void;
  let started!: () => void;
  const firstStarted = new Promise<void>((resolve) => (started = resolve));
  let oldGuard!: () => void;
  const runs: string[] = [];
  const memory = new ExternalRuntimeMemory({
    idleDelayMs: 0,
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
    idleDelayMs: 0,
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
    idleDelayMs: 0,
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

function grown(extra: number) {
  return Array.from({ length: 8 + extra }, (_, index) => ({
    role: index % 2 ? "assistant" : "user",
    content: `turn ${index}`,
  }));
}
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("consecutive turns collapse into one run after the session goes quiet", async () => {
  const runs: string[] = [];
  const memory = new ExternalRuntimeMemory({
    idleDelayMs: 30,
    run: async (input) => {
      runs.push(input.runId);
    },
  });
  jobs.push(memory);
  memory.schedule(snapshot({ runId: "turn-1" }));
  await wait(5);
  memory.schedule(snapshot({ runId: "turn-2", messages: grown(2) }));
  await wait(5);
  memory.schedule(snapshot({ runId: "turn-3", messages: grown(4) }));
  expect(runs).toEqual([]);
  await wait(60);
  await memory.idle("memory-session");
  expect(runs).toEqual(["turn-3"]);
});

test("a new turn starting cancels the waiting snapshot", async () => {
  const runs: string[] = [];
  const memory = new ExternalRuntimeMemory({
    idleDelayMs: 20,
    run: async (input) => {
      runs.push(input.runId);
    },
  });
  jobs.push(memory);
  memory.schedule(snapshot({ runId: "stale" }));
  memory.cancel("memory-session");
  await wait(40);
  expect(runs).toEqual([]);
});

test("dispose drops waiting snapshots", async () => {
  const runs: string[] = [];
  const memory = new ExternalRuntimeMemory({
    idleDelayMs: 20,
    run: async (input) => {
      runs.push(input.runId);
    },
  });
  memory.schedule(snapshot({ runId: "never" }));
  await memory.dispose();
  await wait(40);
  expect(runs).toEqual([]);
});

test("reruns wait until enough new messages accumulate", async () => {
  const runs: string[] = [];
  const memory = new ExternalRuntimeMemory({
    idleDelayMs: 0,
    minNewMessages: 4,
    run: async (input) => {
      runs.push(input.runId);
    },
  });
  jobs.push(memory);
  memory.schedule(snapshot({ runId: "first" }));
  await memory.idle("memory-session");
  memory.schedule(snapshot({ runId: "too-few", messages: grown(2) }));
  await memory.idle("memory-session");
  memory.schedule(snapshot({ runId: "enough", messages: grown(4) }));
  await memory.idle("memory-session");
  memory.schedule(snapshot({ runId: "rewritten", messages: grown(0).slice(0, 8) }));
  await memory.idle("memory-session");
  expect(runs).toEqual(["first", "enough", "rewritten"]);
});

test("a failed run does not count as processed", async () => {
  const runs: string[] = [];
  const memory = new ExternalRuntimeMemory({
    idleDelayMs: 0,
    run: async (input) => {
      runs.push(input.runId);
      if (input.runId === "fails") throw new Error("provider down");
    },
    onError() {},
  });
  jobs.push(memory);
  memory.schedule(snapshot({ runId: "fails" }));
  await memory.idle("memory-session");
  memory.schedule(snapshot({ runId: "retry", messages: grown(1) }));
  await memory.idle("memory-session");
  expect(runs).toEqual(["fails", "retry"]);
});
