import { expect, test } from "bun:test";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine } from "./engine.js";
import { initialToolsFixtureModule } from "./initial-tools-preset.fixture.js";
import { LLMClientBase } from "../llm/client-base.js";
import { registerProvider } from "../llm/client-factory.js";
import type { CreateMessageOptions } from "../llm/types.js";
import type { StreamEvent } from "../types.js";
import { readOutputJournal } from "../session/output-journal.js";

const scenarios = new Map<string, () => void>();
class JournalFailureClient extends LLMClientBase {
  protected initClient(): void {}
  async createMessage(options: CreateMessageOptions) {
    if (options.stream) {
      scenarios.get(this.model)?.();
      // Deliberately model a third-party provider/observer that swallows a
      // streaming callback error and returns a superficially successful body.
      try {
        options.onChunk?.({ type: "text", text: "unpublished" });
      } catch {
        /* fixture */
      }
    }
    return {
      text: "superficially successful",
      toolCalls: [],
      stopReason: "stop",
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    };
  }
}
registerProvider("output-journal-fault-fixture", JournalFailureClient);

const batchScenarios = new Map<
  string,
  { mode: "throw" | "abort" | "close"; controller: AbortController; entered(): void }
>();
class BatchLifecycleClient extends LLMClientBase {
  protected initClient(): void {}
  async createMessage(options: CreateMessageOptions) {
    const scenario = batchScenarios.get(this.model)!;
    options.onChunk?.({ type: "text", text: "queued A" });
    options.onChunk?.({ type: "text", text: "queued B" });
    scenario.entered();
    if (scenario.mode === "throw")
      throw Object.assign(new Error("fixture provider failed"), { status: 400 });
    if (scenario.mode === "abort") scenario.controller.abort();
    else
      await new Promise((_done, reject) =>
        options.signal?.addEventListener(
          "abort",
          () => reject(new DOMException("Closed", "AbortError")),
          { once: true },
        ),
      );
    return {
      text: "queued Aqueued B",
      toolCalls: [],
      stopReason: "stop",
      usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3 },
    };
  }
}
registerProvider("output-batch-lifetime-fixture", BatchLifecycleClient);
for (const mode of ["throw", "abort", "close"] as const)
  test(`actual Engine ${mode} flushes pending deltas before its durable non-success terminal and releases the timer`, async () => {
    const directory = mkdtempSync(join(tmpdir(), "codeshell-output-batch-lifetime-")),
      model = `${mode}-${Math.random()}`;
    const controller = new AbortController();
    let entered!: () => void;
    const ready = new Promise<void>((done) => {
      entered = done;
    });
    batchScenarios.set(model, { mode, controller, entered });
    const engine = new Engine({
      llm: { provider: "output-batch-lifetime-fixture", model, apiKey: "synthetic" } as never,
      cwd: directory,
      sessionStorageDir: join(directory, "sessions"),
      headless: true,
      settingsScope: "isolated",
      enabledBuiltinTools: [],
      maxTurns: 1,
    });
    engine.getHookRegistry().clear();
    const events: StreamEvent[] = [];
    try {
      const running = engine.run("lifetime fixture", {
        behaviorMode: "isolatedTask",
        signal: controller.signal,
        onStream: (event) => {
          events.push(event);
        },
      });
      await ready;
      const closing = mode === "close" ? engine.dispose() : Promise.resolve();
      const result = await running;
      await closing;
      expect(result.reason).not.toBe("completed");
      expect(
        events.filter((event) => event.type === "text_delta").map((event) => event.text),
      ).toEqual(["queued A", "queued B"]);
      const terminal = events.at(-1)!;
      expect(terminal.type).toBe("turn_complete");
      const page = readOutputJournal(join(directory, "sessions"), result.sessionId);
      expect(page.status).toBe("ok");
      expect(page.through).toBe(terminal.outputCursor);
      const count = events.length;
      await new Promise((done) => setTimeout(done, 20));
      expect(events).toHaveLength(count);
    } finally {
      batchScenarios.delete(model);
      await engine.dispose();
      rmSync(directory, { recursive: true, force: true });
    }
  });

for (const fault of ["none", "truncate", "record-rewrite", "header-rewrite"] as const) {
  test(`actual Engine.run without options ${fault === "none" ? "persists complete output" : `fences swallowed ${fault}`}`, async () => {
    const root = mkdtempSync(join(tmpdir(), "codeshell-output-no-options-"));
    const model = `no-options-${fault}-${Math.random()}`;
    const sessionRoot = join(root, "sessions");
    const engine = new Engine({
      llm: { provider: "output-journal-fault-fixture", model, apiKey: "synthetic" } as never,
      cwd: root,
      sessionStorageDir: sessionRoot,
      settingsScope: "isolated",
      headless: true,
      maxTurns: 2,
      enabledBuiltinTools: [],
      behaviorProfiles: [
        {
          id: "fixture",
          activateForSessionKinds: ["work"],
          disableSessionTitle: true,
          disableHooks: true,
          disableInstructions: true,
          disableMemoryContext: true,
          disableCapabilityContext: true,
          disableSourcesContext: true,
          disableMcp: true,
        },
      ],
    });
    engine.getHookRegistry().clear();
    let calls = 0;
    scenarios.set(model, () => {
      calls++;
      const file = join(sessionRoot, readdirSync(sessionRoot)[0], "output-journal.jsonl");
      if (fault === "truncate") truncateSync(file, 0);
      else if (fault !== "none") {
        const raw = readFileSync(file, "utf8");
        const lines = raw.split("\n");
        if (fault === "record-rewrite") lines[1] = lines[1].replace("standard", "modified");
        else {
          const header = JSON.parse(lines[0]);
          header.journalId = `${header.journalId[0] === "a" ? "b" : "a"}${header.journalId.slice(1)}`;
          lines[0] = JSON.stringify(header);
        }
        const changed = lines.join("\n");
        expect(changed).not.toBe(raw);
        expect(Buffer.byteLength(changed)).toBe(Buffer.byteLength(raw));
        writeFileSync(file, changed);
      }
    });
    try {
      const result = await engine.run("Use the standard SDK overload");
      expect(calls).toBe(1);
      if (fault !== "none") {
        expect(result.reason).toBe("model_error");
        expect(
          engine.getSessionManager().readSessionState(result.sessionId)?.outputRecoveryIncomplete,
        ).toBe(true);
        expect(["incomplete", "cursor_invalid"]).toContain(
          readOutputJournal(sessionRoot, result.sessionId).status,
        );
      } else {
        expect(result.reason).toBe("completed");
        const page = readOutputJournal(sessionRoot, result.sessionId);
        expect(page.status).toBe("ok");
        expect(page.complete).toBe(true);
        expect(page.frames.some((frame) => frame.event?.type === "text_delta")).toBe(true);
        expect(page.frames.at(-1)?.event).toMatchObject({
          type: "turn_complete",
          reason: "completed",
        });
      }
    } finally {
      scenarios.delete(model);
      await engine.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  });
}

const privateScenarios = new Map<string, { sentinel: string; consumed: boolean }>();
class PrivateResultClient extends LLMClientBase {
  protected initClient(): void {}
  async createMessage(options: CreateMessageOptions) {
    const scenario = privateScenarios.get(this.model)!;
    const raw = JSON.stringify(options.messages);
    if (raw.includes(scenario.sentinel)) scenario.consumed = true;
    const call = options.stream && !raw.includes('"tool_use_id":"private-call"');
    return {
      text: call ? "" : "Private result consumed",
      toolCalls: call ? [{ id: "private-call", toolName: "PrivateFixture", args: {} }] : [],
      stopReason: call ? "tool_use" : "stop",
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    };
  }
}
registerProvider("output-journal-private-fixture", PrivateResultClient);

test("actual Engine keeps sensitive raw tool results out of output journal, recovery and transcript", async () => {
  const root = mkdtempSync(join(tmpdir(), "codeshell-output-private-"));
  const model = `private-${Math.random()}`,
    sentinel = `RAW_PRIVATE_SENTINEL_${Math.random()}`;
  const scenario = { sentinel, consumed: false };
  privateScenarios.set(model, scenario);
  const placeholder = "[private tool result withheld]";
  const engine = new Engine({
    llm: { provider: "output-journal-private-fixture", model, apiKey: "synthetic" } as never,
    modules: [initialToolsFixtureModule(["PrivateFixture"])],
    cwd: root,
    sessionStorageDir: join(root, "sessions"),
    settingsScope: "isolated",
    headless: true,
    permissionMode: "bypassPermissions",
    maxTurns: 4,
    enabledBuiltinTools: [],
    behaviorProfiles: [
      {
        id: "fixture",
        disableSessionTitle: true,
        disableHooks: true,
        disableInstructions: true,
        disableMemoryContext: true,
        disableCapabilityContext: true,
        disableSourcesContext: true,
        disableMcp: true,
      },
    ],
  });
  engine.getHookRegistry().clear();
  engine.registerCustomTool(
    {
      name: "PrivateFixture",
      description: "Returns a private fixture value",
      inputSchema: { type: "object", properties: {} },
      source: "builtin",
      permissionDefault: "allow",
    },
    () => ({
      id: "private-call",
      toolName: "PrivateFixture",
      sensitive: true,
      result: sentinel,
      displayResult: placeholder,
      transcriptResult: placeholder,
      contentBlocks: [{ type: "text", text: sentinel }],
    }),
  );
  const events: StreamEvent[] = [];
  try {
    const result = await engine.run("Consume the private fixture without echoing it", {
      sessionId: "private-result",
      behaviorMode: "fixture",
      onStream: (event) => {
        events.push(event);
      },
    });
    expect(result.reason).toBe("completed");
    expect(scenario.consumed).toBe(true);
    for (const filename of ["output-journal.jsonl", "transcript.jsonl"]) {
      const saved = readFileSync(join(root, "sessions", "private-result", filename), "utf8");
      expect(saved).not.toContain(sentinel);
      expect(saved).toContain(placeholder);
    }
    expect(JSON.stringify(events)).not.toContain(sentinel);
    let page = readOutputJournal(join(root, "sessions"), "private-result", { maxFrames: 2 });
    const through = page.through;
    for (let pageNumber = 0; pageNumber < 64; pageNumber++) {
      expect(page.status).toBe("ok");
      expect(JSON.stringify(page)).not.toContain(sentinel);
      if (page.complete) break;
      page = readOutputJournal(join(root, "sessions"), "private-result", {
        after: page.next,
        through,
        maxFrames: 2,
      });
    }
    expect(page.complete).toBe(true);
    expect(events.filter((event) => event.type === "tool_result")).toMatchObject([
      { type: "tool_result", result: { result: placeholder, sensitive: true } },
    ]);
  } finally {
    privateScenarios.delete(model);
    await engine.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

for (const mode of ["empty", "missing"] as const) {
  test(`actual Engine restart refuses a previously published journal that became ${mode}`, async () => {
    const root = mkdtempSync(join(tmpdir(), "codeshell-output-restart-"));
    const model = `restart-${mode}-${Math.random()}`;
    const file = join(root, "sessions", "published", "output-journal.jsonl");
    let requests = 0;
    scenarios.set(model, () => {
      requests++;
    });
    const makeEngine = () => {
      const engine = new Engine({
        llm: { provider: "output-journal-fault-fixture", model, apiKey: "synthetic" } as never,
        cwd: root,
        sessionStorageDir: join(root, "sessions"),
        settingsScope: "isolated",
        headless: true,
        maxTurns: 2,
        behaviorProfiles: [
          {
            id: "fixture",
            disableSessionTitle: true,
            disableHooks: true,
            disableInstructions: true,
            disableMemoryContext: true,
            disableCapabilityContext: true,
            disableSourcesContext: true,
            disableMcp: true,
          },
        ],
      });
      engine.getHookRegistry().clear();
      return engine;
    };
    let engine = makeEngine();
    try {
      expect(
        (await engine.run("publish once", { sessionId: "published", behaviorMode: "fixture" }))
          .reason,
      ).toBe("completed");
      expect(requests).toBe(1);
      await engine.dispose();
      if (mode === "empty") truncateSync(file, 0);
      else rmSync(file);
      expect(readOutputJournal(join(root, "sessions"), "published").status).toBe("incomplete");
      engine = makeEngine();
      const events: StreamEvent[] = [];
      const result = await engine.run("fresh intent after restart", {
        sessionId: "published",
        behaviorMode: "fixture",
        onStream: (event) => {
          events.push(event);
        },
      });
      expect(result.reason).toBe("model_error");
      expect(requests).toBe(1);
      expect(
        events.some((event) => event.type === "turn_complete" && event.reason === "completed"),
      ).toBe(false);
      expect(events.at(-1)?.outputRecovery).toBe("incomplete");
    } finally {
      scenarios.delete(model);
      await engine.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test("actual Engine rejects a swallowed journal write failure and never reports completed", async () => {
  if (process.platform === "win32" || process.getuid?.() === 0) return;
  const root = mkdtempSync(join(tmpdir(), "codeshell-output-engine-"));
  const model = `journal-${Date.now()}-${Math.random()}`;
  const file = join(root, "sessions", "fault", "output-journal.jsonl");
  const engine = new Engine({
    llm: { provider: "output-journal-fault-fixture", model, apiKey: "synthetic" } as never,
    cwd: root,
    sessionStorageDir: join(root, "sessions"),
    settingsScope: "isolated",
    headless: true,
    maxTurns: 1,
    behaviorProfiles: [
      {
        id: "journal-fixture",
        disableSessionTitle: true,
        disableHooks: true,
        disableInstructions: true,
        disableMemoryContext: true,
        disableCapabilityContext: true,
        disableSourcesContext: true,
        disableMcp: true,
      },
    ],
  });
  engine.getHookRegistry().clear();
  let requests = 0;
  scenarios.set(model, () => {
    requests++;
    chmodSync(file, 0o400);
  });
  const events: StreamEvent[] = [];
  try {
    const result = await engine.run("Return a fixture confirmation", {
      sessionId: "fault",
      clientMessageId: "fault-submit",
      behaviorMode: "journal-fixture",
      onStream: (event) => {
        events.push(event);
      },
    });
    expect(result.reason).toBe("model_error");
    expect(
      events.some((event) => event.type === "turn_complete" && event.reason === "completed"),
    ).toBe(false);
    expect(
      events.some((event) => event.type === "text_delta" && event.text === "unpublished"),
    ).toBe(false);
    expect(events.at(-1)).toMatchObject({
      type: "turn_complete",
      reason: "model_error",
      outputRecovery: "incomplete",
    });
    const state = JSON.parse(readFileSync(join(root, "sessions", "fault", "state.json"), "utf8"));
    expect(state.status).toBe("model_error");
    expect(state.outputRecoveryIncomplete).toBe(true);
    expect(readOutputJournal(join(root, "sessions"), "fault").status).toBe("incomplete");
    chmodSync(file, 0o600);
    const next = await engine.run("A fresh intent cannot bypass a damaged output journal", {
      sessionId: "fault",
      clientMessageId: "second-intent",
      behaviorMode: "journal-fixture",
      onStream: (event) => {
        events.push(event);
      },
    });
    expect(next.reason).toBe("model_error");
    expect(requests).toBe(1);
    expect(events.at(-1)).toMatchObject({
      type: "turn_complete",
      reason: "model_error",
      outputRecovery: "incomplete",
    });
  } finally {
    scenarios.delete(model);
    chmodSync(file, 0o600);
    await engine.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});
