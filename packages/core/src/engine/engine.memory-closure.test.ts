import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Engine } from "./engine.js";
import { EngineRuntime } from "./runtime.js";
import { ModelPool } from "../llm/model-pool.js";
import { SettingsManager } from "../settings/manager.js";
import { MCPManager } from "../tool-system/mcp-manager.js";
import { ToolRegistry } from "../tool-system/registry.js";
import type {
  AuxiliaryPipeline,
  EngineLlmClient,
  MemoryClosureInput,
} from "./auxiliary-pipeline.js";
import { MemorySegments } from "./memory-segments.js";
import { LLMClientBase } from "../llm/client-base.js";
import { registerProvider } from "../llm/client-factory.js";
import type { CreateMessageOptions } from "../llm/types.js";
import { MemoryClosureScheduler, type MemoryCursor } from "../services/memory-closure.js";
import type { SessionBundle } from "../session/session-manager.js";
import type { Transcript } from "../session/transcript.js";
import type { LLMResponse, TranscriptEvent } from "../types.js";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("MemorySegments", () => {
  let sequence = 0;
  const event = (data: Record<string, unknown>, timestamp = Date.now()): TranscriptEvent => ({
    id: `segment-${++sequence}`,
    type: "message",
    timestamp,
    turnNumber: 0,
    data,
  });
  const client = {} as EngineLlmClient;

  function segments(options: { scheduler?: MemoryClosureScheduler; unattended?: boolean } = {}) {
    const closures: MemoryClosureInput[] = [];
    const cursors = new Map<string, MemoryCursor>();
    const pipeline = {
      runMemoryClosure: async (input: MemoryClosureInput) => void closures.push(input),
    } as unknown as AuxiliaryPipeline;
    return {
      closures,
      cursors,
      segments: new MemorySegments({
        pipeline,
        scheduler: () => options.scheduler,
        unattended: options.unattended === true,
        readCursor: (sessionId) => cursors.get(sessionId),
        writeCursor: (sessionId, cursor) => void cursors.set(sessionId, cursor),
      }),
    };
  }
  const transcriptOf = (events: TranscriptEvent[]) =>
    ({ getEvents: () => [...events] }) as unknown as Transcript;
  const bundle = (events: TranscriptEvent[], state: Record<string, unknown> = {}) =>
    ({
      state: { sessionId: "s1", ...state },
      transcript: transcriptOf(events),
    }) as unknown as SessionBundle;

  test("without a shared scheduler a run's end closes the segment straight away", async () => {
    const fixture = segments();
    const events = [event({ role: "user", content: "hi" })];
    await fixture.segments.runEnded({
      transcript: transcriptOf(events),
      sessionId: "s1",
      cwd: "/project",
      primaryClient: client,
    });
    expect(fixture.closures).toHaveLength(1);
    expect(fixture.closures[0]).toMatchObject({
      sessionId: "s1",
      cwd: "/project",
      trigger: "run-end",
      events,
    });
  });

  test("the closure's cursor callbacks address the session it closes", async () => {
    const fixture = segments();
    await fixture.segments.runEnded({
      transcript: transcriptOf([]),
      sessionId: "s1",
      cwd: "/project",
      primaryClient: client,
    });
    const cursor: MemoryCursor = { v: 1, eventId: "e", at: 1, closedAt: 2 };
    fixture.closures[0]!.writeCursor(cursor);
    expect(fixture.cursors.get("s1")).toEqual(cursor);
    expect(fixture.closures[0]!.readCursor()).toEqual(cursor);
  });

  test("with a scheduler the closure waits for quiet and reads the events as they are then", async () => {
    const scheduler = new MemoryClosureScheduler({ idleMs: 30 });
    const fixture = segments({ scheduler });
    const events = [event({ role: "user", content: "first" })];
    await fixture.segments.runEnded({
      transcript: transcriptOf(events),
      sessionId: "s1",
      cwd: "/project",
      primaryClient: client,
    });
    expect(fixture.closures).toHaveLength(0);
    events.push(event({ role: "assistant", content: "appended while waiting" }));
    await wait(70);
    expect(fixture.closures).toHaveLength(1);
    expect(fixture.closures[0]!.trigger).toBe("idle");
    expect(fixture.closures[0]!.events).toHaveLength(2);
    scheduler.dispose();
  });

  test("runs that follow each other closely share one closure", async () => {
    const scheduler = new MemoryClosureScheduler({ idleMs: 40 });
    const fixture = segments({ scheduler });
    const events = [event({ role: "user", content: "first" })];
    const ended = () =>
      fixture.segments.runEnded({
        transcript: transcriptOf(events),
        sessionId: "s1",
        cwd: "/project",
        primaryClient: client,
      });
    await ended();
    await wait(15);
    const next = event({ role: "user", content: "second" });
    events.push(next);
    fixture.segments.runStarted({
      session: bundle(events),
      runId: next.id,
      cwd: "/project",
      primaryClient: client,
      memoryDisabled: false,
    });
    expect(scheduler.hasPending("s1")).toBe(false);
    await ended();
    await wait(90);
    expect(fixture.closures).toHaveLength(1);
    scheduler.dispose();
  });

  test("a run that resumes after a long gap closes the stretch before it", async () => {
    const scheduler = new MemoryClosureScheduler({ idleMs: 1000 });
    const fixture = segments({ scheduler });
    const old = [
      event({ role: "user", content: "yesterday" }, Date.now() - 5000),
      event({ role: "assistant", content: "answer" }, Date.now() - 4000),
    ];
    const next = event({ role: "user", content: "today" });
    fixture.segments.runStarted({
      session: bundle([...old, next]),
      runId: next.id,
      cwd: "/project",
      primaryClient: client,
      memoryDisabled: false,
    });
    await scheduler.idle("s1");
    expect(fixture.closures).toHaveLength(1);
    expect(fixture.closures[0]!.trigger).toBe("resume");
    // Only what came before this run: its own message belongs to the next segment.
    expect(fixture.closures[0]!.events).toEqual(old);
    scheduler.dispose();
  });

  test("a run that follows recent activity only continues the segment", async () => {
    const scheduler = new MemoryClosureScheduler({ idleMs: 60_000 });
    const fixture = segments({ scheduler });
    const recent = event({ role: "assistant", content: "a moment ago" });
    const next = event({ role: "user", content: "now" });
    fixture.segments.runStarted({
      session: bundle([recent, next]),
      runId: next.id,
      cwd: "/project",
      primaryClient: client,
      memoryDisabled: false,
    });
    await scheduler.idle("s1");
    expect(fixture.closures).toHaveLength(0);
    scheduler.dispose();
  });

  test("a stretch the cursor already covers is not closed again on resume", async () => {
    const scheduler = new MemoryClosureScheduler({ idleMs: 1000 });
    const fixture = segments({ scheduler });
    const old = event({ role: "assistant", content: "covered" }, Date.now() - 5000);
    const next = event({ role: "user", content: "today" });
    fixture.segments.runStarted({
      session: bundle([old, next], {
        memoryCursor: { v: 1, eventId: old.id, at: old.timestamp, closedAt: 1 },
      }),
      runId: next.id,
      cwd: "/project",
      primaryClient: client,
      memoryDisabled: false,
    });
    await scheduler.idle("s1");
    expect(fixture.closures).toHaveLength(0);
    scheduler.dispose();
  });

  test.each([
    ["a run with memory turned off", { memoryDisabled: true }, {}],
    ["an ephemeral session", { memoryDisabled: false }, { ephemeral: true }],
  ])("%s neither resumes nor cancels a closure", async (_name, run, state) => {
    const scheduler = new MemoryClosureScheduler({ idleMs: 1000 });
    const fixture = segments({ scheduler });
    scheduler.schedule("s1", async () => {});
    const old = event({ role: "assistant", content: "old" }, Date.now() - 5000);
    const next = event({ role: "user", content: "new" });
    fixture.segments.runStarted({
      session: bundle([old, next], state),
      runId: next.id,
      cwd: "/project",
      primaryClient: client,
      ...run,
    });
    expect(scheduler.hasPending("s1")).toBe(true);
    expect(fixture.closures).toHaveLength(0);
    scheduler.dispose();
  });

  test("an unattended Engine's runs never close a segment: nobody types in its sessions", async () => {
    const scheduler = new MemoryClosureScheduler({ idleMs: 10 });
    const fixture = segments({ scheduler, unattended: true });
    const old = event({ role: "user", content: "task from the parent" }, Date.now() - 5000);
    const next = event({ role: "user", content: "follow-up" });
    await fixture.segments.runEnded({
      transcript: transcriptOf([old]),
      sessionId: "s1",
      cwd: "/project",
      primaryClient: client,
    });
    fixture.segments.runStarted({
      session: bundle([old, next]),
      runId: next.id,
      cwd: "/project",
      primaryClient: client,
      memoryDisabled: false,
    });
    await wait(40);
    expect(fixture.closures).toHaveLength(0);
    scheduler.dispose();
  });
});

const provider = "fake-memory-closure";
const extractionPromptsByModel = new Map<string, string[]>();
const tempDirs: string[] = [];
const previousCodeShellHome = process.env.CODE_SHELL_HOME;
const previousHome = process.env.HOME;

class MemoryClosureClient extends LLMClientBase {
  protected initClient(): void {}

  async createMessage(options: CreateMessageOptions): Promise<LLMResponse> {
    const prompt = options.messages
      .map((message) => (typeof message.content === "string" ? message.content : ""))
      .join("");
    const extraction = prompt.includes("memory extraction assistant");
    if (extraction) extractionPromptsByModel.get(this.model)?.push(prompt);
    const usage = { promptTokens: 1, completionTokens: 1, totalTokens: 2 };
    this.recordUsage(usage, options);
    return { text: extraction ? "[]" : "done", toolCalls: [], stopReason: "stop", usage };
  }
}

registerProvider(provider, MemoryClosureClient);

afterEach(() => {
  extractionPromptsByModel.clear();
  if (previousCodeShellHome === undefined) delete process.env.CODE_SHELL_HOME;
  else process.env.CODE_SHELL_HOME = previousCodeShellHome;
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("Engine memory closure after a run", () => {
  function setup(name: string, config: Record<string, unknown> = {}) {
    const root = mkdtempSync(join(tmpdir(), "engine-memory-closure-"));
    tempDirs.push(root);
    process.env.CODE_SHELL_HOME = join(root, "code-shell-home");
    process.env.HOME = join(root, "user-home");
    const cwd = join(root, "project");
    const model = `${provider}-${name}-${Date.now()}-${Math.random()}`;
    const extractionPrompts: string[] = [];
    extractionPromptsByModel.set(model, extractionPrompts);
    const engine = new Engine({
      llm: { provider, model, apiKey: "test" } as never,
      cwd,
      sessionStorageDir: join(root, "sessions"),
      permissionMode: "bypassPermissions",
      settingsScope: "isolated",
      headless: true,
      maxTurns: 1,
      ...config,
    });
    (engine as any).hooks.clear();
    const manager = engine.getSessionManager();
    const session = manager.create(cwd, model, provider, `closure-${name}`);
    for (let index = 0; index < 4; index++) {
      session.transcript.appendMessage("user", `earlier question ${index}`);
      session.transcript.appendMessage("assistant", `earlier answer ${index}`);
    }
    // The pipeline is fire-and-forget; capture it so assertions are deterministic.
    const pending: Promise<void>[] = [];
    const original = (engine as any).runMemoryPipeline.bind(engine);
    (engine as any).runMemoryPipeline = (...args: unknown[]) => {
      const promise = original(...args);
      pending.push(promise);
      return promise;
    };
    const sessionId = session.state.sessionId;
    return {
      engine,
      manager,
      sessionId,
      extractionPrompts,
      run: async (text: string) => {
        await engine.run(text, { sessionId } as any);
        await Promise.all(pending.splice(0));
      },
    };
  }

  test("a one-shot host closes the segment at run end and records how far it read", async () => {
    const fixture = setup("immediate");
    await fixture.run("the newest question");

    expect(fixture.extractionPrompts).toHaveLength(1);
    expect(fixture.extractionPrompts[0]).toContain("[user]: earlier question 0");
    expect(fixture.extractionPrompts[0]).toContain("[user]: the newest question");
    const cursor = fixture.manager.readSessionState(fixture.sessionId)!.memoryCursor!;
    expect(cursor.v).toBe(1);

    await fixture.run("a later question");
    expect(fixture.extractionPrompts).toHaveLength(2);
    const later = fixture.extractionPrompts[1]!;
    expect(later).toContain("[user]: a later question");
    expect(later).toContain("[context]: Earlier messages, already covered by a previous pass.");
    // Covered turns are not re-read as conversation.
    expect(later).not.toContain("[user]: earlier question 0");
    expect(later).not.toContain("[user]: the newest question");
    const advanced = fixture.manager.readSessionState(fixture.sessionId)!.memoryCursor!;
    expect(advanced.eventId).not.toBe(cursor.eventId);
    await fixture.engine.dispose();
  });

  test("a long-lived host closes the segment after the quiet period, billed to the session", async () => {
    const registry = new ToolRegistry({ builtinTools: [] });
    const scratch = mkdtempSync(join(tmpdir(), "engine-memory-closure-runtime-"));
    tempDirs.push(scratch);
    const runtime = new EngineRuntime({
      modelPool: new ModelPool(),
      toolRegistry: registry,
      settings: new SettingsManager(scratch, "isolated"),
      mcpPool: new MCPManager(registry),
      costTracker: {} as never,
      usageStorageDir: join(scratch, "usage"),
      // Long enough that a busy test process cannot fire it before the run returns.
      memoryClosureIdleMs: 500,
    });
    const fixture = setup("idle", { runtime });
    const requests = () =>
      fixture.engine.getUsageSummary({ scope: "session", sessionId: fixture.sessionId }).requests;

    await fixture.run("the newest question");
    // The run is over; its memories wait for the session to go quiet.
    expect(fixture.extractionPrompts).toHaveLength(0);
    expect(runtime.memoryClosures!.hasPending(fixture.sessionId)).toBe(true);
    const beforeClosure = requests();

    const deadline = Date.now() + 10_000;
    while (runtime.memoryClosures!.hasPending(fixture.sessionId) && Date.now() < deadline) {
      await wait(25);
    }
    expect(fixture.extractionPrompts).toHaveLength(1);
    expect(fixture.manager.readSessionState(fixture.sessionId)!.memoryCursor).toBeDefined();
    // The closure ran from a timer, long after the run's own call stack.
    expect(requests()).toBe(beforeClosure + 1);
    await fixture.engine.dispose();
    await runtime.close();
  });

  test.each([
    ["a sub-agent", { isSubAgent: true }],
    ["an automation", { origin: "automation" }],
  ])("%s run extracts nothing: nobody typed its prompt", async (name, config) => {
    const fixture = setup(name.replaceAll(" ", "-"), config);
    await fixture.run("task handed over by something that is not a person");
    expect(fixture.extractionPrompts).toHaveLength(0);
    expect(fixture.manager.readSessionState(fixture.sessionId)!.memoryCursor).toBeUndefined();
    await fixture.engine.dispose();
  });

  test("with the flag off every run re-reads the whole window and no cursor is kept", async () => {
    const fixture = setup("legacy");
    (fixture.engine as any).memorySegmentClosureEnabled = () => false;
    await fixture.run("the newest question");
    await fixture.run("a later question");

    expect(fixture.extractionPrompts).toHaveLength(2);
    expect(fixture.extractionPrompts[1]).toContain("[user]: earlier question 0");
    expect(fixture.extractionPrompts[1]).not.toContain("[context]:");
    expect(fixture.manager.readSessionState(fixture.sessionId)!.memoryCursor).toBeUndefined();
    await fixture.engine.dispose();
  });
});
