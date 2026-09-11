import { expect, test } from "bun:test";
import { ChatSession } from "./chat-session.js";
import type { Engine, EngineRunOptions } from "../engine/engine.js";
import type { StreamEvent } from "../types.js";

test("scoped cancellation rejects stale input identities and preserves queued turns", async () => {
  const runs: string[] = [];
  const engine = {
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
  } as unknown as Engine;
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
  const engine = {
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
  } as unknown as Engine;
  const session = new ChatSession({ id: "work", engine, onStream: (event) => events.push(event) });
  await session.enqueueTurn("work", { clientMessageId: "current-submit" });
  expect(events[0]).toMatchObject({ reason: "model_error", clientMessageId: "current-submit" });
});

test("run callbacks retain their own identity across queued and background turns", async () => {
  const callbacks: NonNullable<EngineRunOptions["onStream"]>[] = [];
  const events: StreamEvent[] = [];
  const engine = {
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
  } as unknown as Engine;
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
  const engine = {
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
  } as unknown as Engine;
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
