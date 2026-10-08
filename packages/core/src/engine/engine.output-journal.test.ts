import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, truncateSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine } from "./engine.js";
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

for (const fault of [false, true]) {
  test(`actual Engine.run without options ${fault ? "fences a swallowed write failure" : "persists complete output"}`, async () => {
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
      if (fault)
        truncateSync(join(sessionRoot, readdirSync(sessionRoot)[0], "output-journal.jsonl"), 0);
    });
    try {
      const result = await engine.run("Use the standard SDK overload");
      expect(calls).toBe(1);
      if (fault) {
        expect(result.reason).toBe("model_error");
        expect(
          engine.getSessionManager().readSessionState(result.sessionId)?.outputRecoveryIncomplete,
        ).toBe(true);
        expect(readOutputJournal(sessionRoot, result.sessionId).status).toBe("incomplete");
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
