import { createFakeEngine } from "../testing/create-fake-engine.js";
import { expect, test } from "bun:test";
import { ChatSession } from "./chat-session.js";

import type { EngineRunOptions } from "../engine/run-types.js";
import type { StreamEvent } from "../types.js";

test("scoped cancellation rejects stale input identities and preserves queued turns", async () => {
  const runs: string[] = [];
  const engine = createFakeEngine({
    async run(task: string, options: EngineRunOptions) {
      runs.push(task);
      if (task === "first") {
        await new Promise<void>((_resolve, reject) => {
          options.signal!.addEventListener("abort", () =>
            reject(new DOMException("stopped", "AbortError")),
          );
        });
      }
      return {
        text: "done",
        reason: "completed",
        sessionId: "work",
        turnCount: 1,
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      };
    },
  });
  const session = new ChatSession({ id: "work", engine });
  const first = session.enqueueTurn("first", { clientMessageId: "first-input" });
  const second = session.enqueueTurn("second", { clientMessageId: "second-input" });
  expect(session.matchesActiveTurn("second-input")).toBe(false);
  expect(session.cancelActiveTurn("second-input")).toBe(false);
  expect(session.cancelActiveTurn("first-input")).toBe(true);
  expect((await first).reason).toBe("aborted_streaming");
  expect((await second).text).toBe("done");
  expect(session.wasCancelledSinceLastTurn()).toBe(false);
  expect(session.cancelActiveTurn("first-input")).toBe(false);
  expect(runs).toEqual(["first", "second"]);
});

test("retains the submit identity when initialization fails before session_started", async () => {
  const events: StreamEvent[] = [];
  const engine = createFakeEngine({
    async run(_task: string, options: EngineRunOptions) {
      options.onStream?.({ type: "turn_complete", reason: "model_error" });
      return {
        text: "failed",
        reason: "model_error",
        sessionId: "work",
        turnCount: 0,
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      };
    },
  });
  const session = new ChatSession({ id: "work", engine, onStream: (event) => events.push(event) });
  await session.enqueueTurn("work", { clientMessageId: "current-submit" });
  expect(events[0]).toMatchObject({ reason: "model_error", clientMessageId: "current-submit" });
});

test("queued runs forward their operation batch token and session brief", async () => {
  const runs: EngineRunOptions[] = [];
  const engine = createFakeEngine({
    async run(_task: string, options: EngineRunOptions) {
      runs.push(options);
      return {
        text: "done",
        reason: "completed",
        sessionId: "work",
        turnCount: 1,
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      };
    },
  });
  const session = new ChatSession({ id: "work", engine });
  const batch = session.enqueueTurn("batch task", {
    clientMessageId: "batch-input",
    operationBatchToken: "host-batch-token",
    sessionBrief: "Team brief for the native session",
  });
  const ordinary = session.enqueueTurn("ordinary task", { clientMessageId: "ordinary-input" });
  await Promise.all([batch, ordinary]);
  expect(runs[0]).toMatchObject({
    clientMessageId: "batch-input",
    operationBatchToken: "host-batch-token",
    sessionBrief: "Team brief for the native session",
  });
  expect(runs[1]?.operationBatchToken).toBeUndefined();
  expect(runs[1]?.sessionBrief).toBeUndefined();
});

test("run callbacks retain their own identity across queued and background turns", async () => {
  const callbacks: NonNullable<EngineRunOptions["onStream"]>[] = [];
  const events: StreamEvent[] = [];
  const engine = createFakeEngine({
    async run(_task: string, options: EngineRunOptions) {
      const emit = options.onStream!;
      callbacks.push(emit);
      emit({
        type: "session_started",
        sessionId: "work",
        promptTokens: 0,
        runId: `message-${callbacks.length}`,
        clientMessageId: options.clientMessageId,
      });
      emit({ type: "turn_complete", reason: "completed" });
      return {
        text: "done",
        reason: "completed",
        sessionId: "work",
        turnCount: 1,
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      };
    },
  });
  const session = new ChatSession({ id: "work", engine, onStream: (event) => events.push(event) });
  await session.enqueueTurn("first", { clientMessageId: "submit" });
  await session.enqueueTurn("background result", { injected: true });
  callbacks[0]!({ type: "turn_complete", reason: "completed" });
  expect(events.filter((event) => event.type === "turn_complete")).toMatchObject([
    { runId: "message-1", clientMessageId: "submit" },
    { runId: "message-2" },
    { runId: "message-1", clientMessageId: "submit" },
  ]);
});

test("queued host tasks retain their original hard tool/Skill ceiling and ephemeral flag", async () => {
  let release!: () => void;
  const gate = new Promise<void>((done) => {
    release = done;
  });
  const runs: EngineRunOptions[] = [];
  const engine = createFakeEngine({
    run: async (_task: string, options: EngineRunOptions) => {
      runs.push(options);
      if (runs.length === 1) await gate;
      return {
        text: "done",
        reason: "completed",
        sessionId: "task",
        turnCount: 1,
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      };
    },
  });
  const session = new ChatSession({ id: "task", engine });
  const first = session.enqueueTurn("hold", {});
  const tools = ["Write"];
  const skills = ["sample:setup"];
  const isolated = session.enqueueTurn("panel task", {
    behaviorMode: "isolatedTask",
    toolAllowlist: tools,
    skillAllowlist: skills,
    ephemeral: true,
  });
  tools.push("Bash");
  skills.push("other:secret");
  const empty = session.enqueueTurn("no tools", {
    toolAllowlist: [],
    skillAllowlist: [],
    ephemeral: false,
  });
  release();
  await Promise.all([first, isolated, empty]);
  expect(runs[1]).toMatchObject({
    behaviorMode: "isolatedTask",
    toolAllowlist: ["Write"],
    skillAllowlist: ["sample:setup"],
    ephemeral: true,
  });
  expect(runs[2]).toMatchObject({ toolAllowlist: [], skillAllowlist: [], ephemeral: false });
});

test("a turn's trigger marks its own top-level session_started only", async () => {
  const events: StreamEvent[] = [];
  const engine = createFakeEngine({
    async run(_task: string, options: EngineRunOptions) {
      const emit = options.onStream!;
      emit({
        type: "session_started",
        sessionId: "work",
        promptTokens: 0,
        runId: "child-run",
        agentId: "child",
      } as StreamEvent);
      emit({ type: "session_started", sessionId: "work", promptTokens: 0, runId: "run" });
      emit({ type: "turn_complete", reason: "completed" });
      return {
        text: "done",
        reason: "completed",
        sessionId: "work",
        turnCount: 1,
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      };
    },
  });
  const session = new ChatSession({ id: "work", engine, onStream: (event) => events.push(event) });
  await session.enqueueTurn("wake", { injected: true, trigger: "background_wake" });
  await session.enqueueTurn("legacy", {});
  const started = events.filter((event) => event.type === "session_started");
  expect(started.map((event) => ("trigger" in event ? event.trigger : undefined))).toEqual([
    undefined,
    "background_wake",
    undefined,
    undefined,
  ]);
  expect(events.some((event) => event.type === "turn_complete" && "trigger" in event)).toBe(false);
});

test("a turn's trigger is recorded on its own turn_complete outcome", async () => {
  const events: StreamEvent[] = [];
  const engine = {
    async run(_task: string, options: EngineRunOptions) {
      const emit = options.onStream!;
      emit({ type: "session_started", sessionId: "work", promptTokens: 0, runId: "run" });
      emit({
        type: "turn_complete",
        reason: "completed",
        outcome: { didWork: false, backgroundPending: false },
        agentId: "child",
      } as StreamEvent);
      emit({
        type: "turn_complete",
        reason: "completed",
        outcome: { didWork: false, backgroundPending: false },
      });
      return {
        text: "done",
        reason: "completed",
        sessionId: "work",
        turnCount: 1,
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      };
    },
  } as unknown as Engine;
  const session = new ChatSession({ id: "work", engine, onStream: (event) => events.push(event) });
  await session.enqueueTurn("wake", { injected: true, trigger: "background_wake" });
  await session.enqueueTurn("host", { trigger: "host_message" });
  await session.enqueueTurn("legacy", {});
  const outcomes = events.flatMap((event) => (event.type === "turn_complete" ? [event] : []));
  expect(outcomes.map((event) => [event.agentId, event.outcome])).toEqual([
    // A child's terminal is never the run's outcome.
    ["child", { didWork: false, backgroundPending: false }],
    // A background wake exists to act on finished work.
    [undefined, { didWork: true, backgroundPending: false, trigger: "background_wake" }],
    ["child", { didWork: false, backgroundPending: false }],
    [undefined, { didWork: false, backgroundPending: false, trigger: "host_message" }],
    ["child", { didWork: false, backgroundPending: false }],
    [undefined, { didWork: false, backgroundPending: false }],
  ]);
});
