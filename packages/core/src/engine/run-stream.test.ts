import { afterEach, describe, expect, test } from "bun:test";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  truncateSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readOutputJournal } from "../session/output-journal.js";
import { SessionManager } from "../session/session-manager.js";
import type { StreamCallback, StreamEvent, TaskInfo } from "../types.js";
import { buildWrappedOnStream, createRunOutputJournalPolicy } from "./run-stream.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function fixture(options: { ephemeral?: boolean; onStream?: StreamCallback } = {}) {
  const root = mkdtempSync(join(tmpdir(), "codeshell-run-stream-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const id = "parent-session";
  const manager = new SessionManager(root);
  const session = manager.create(
    root,
    "fixture",
    "fixture",
    id,
    null,
    undefined,
    "work",
    options.ephemeral === true,
  );
  const runId = session.transcript.appendMessage("user", "start background work").id;
  manager.startSessionRun(session.state, runId);
  const events: StreamEvent[] = [];
  const todoSnapshots: TaskInfo[][] = [];
  const wrapped = buildWrappedOnStream({
    getSession: () => session,
    setLatestTodos: (todos) => todoSnapshots.push(todos),
    outputJournal: createRunOutputJournalPolicy(
      manager,
      () => session,
      () => runId,
    ),
    userOnStream: (event) => {
      events.push(event);
      options.onStream?.(event);
    },
  });
  cleanups.push(() => wrapped.finish());
  wrapped({ type: "session_started", sessionId: id, promptTokens: 0 });
  return {
    root,
    id,
    manager,
    session,
    runId,
    events,
    todoSnapshots,
    wrapped,
    directory: join(root, id),
    journal: join(root, id, "output-journal.jsonl"),
    nextRun() {
      const nextRunId = session.transcript.appendMessage("user", "next parent run").id;
      manager.startSessionRun(session.state, nextRunId);
      return nextRunId;
    },
  };
}

const childStart: StreamEvent = {
  type: "agent_start",
  agentId: "background-child",
  name: "Background check",
  description: "Check the message",
};

describe("run stream background output boundaries", () => {
  test("late parent text and thinking are rejected without marking recovery incomplete", () => {
    const f = fixture();
    f.wrapped({ type: "text_delta", text: "parent output" });
    f.wrapped.finish();
    const before = readFileSync(f.journal);
    for (const type of ["text_delta", "thinking_delta"] as const) {
      expect(() => f.wrapped({ type, text: "late parent output" })).toThrow("closed");
    }
    expect(f.manager.readSessionState(f.id)?.outputRecoveryIncomplete).not.toBe(true);
    expect(readFileSync(f.journal)).toEqual(before);
    expect(readOutputJournal(f.root, f.id).status).toBe("ok");
  });

  test("child lifecycle and late details keep parent cursors after finish and a successor run", () => {
    const f = fixture();
    const child = fixture();
    child.wrapped({ type: "text_delta", text: "late child output" });
    child.wrapped.finish();
    const origin = child.events.at(-1)!.outputCursor!;
    f.wrapped(childStart);
    f.wrapped({
      type: "agent_backgrounded",
      agentId: "background-child",
      description: "Check the message",
    });
    f.wrapped.finish();
    const nextRunId = f.nextRun();
    f.wrapped({
      type: "text_delta",
      agentId: "background-child",
      text: "late child output",
      outputCursor: origin,
    });
    f.wrapped({ type: "thinking_delta", agentId: "background-child", text: "late thinking" });
    f.wrapped({
      type: "agent_end",
      agentId: "background-child",
      description: "Check the message",
      text: "Check complete",
    });
    const page = readOutputJournal(f.root, f.id);
    expect(page.status).toBe("ok");
    const frames = page.frames.filter((frame) => frame.event && "agentId" in frame.event);
    expect(frames.map((frame) => frame.event?.type)).toEqual([
      "agent_start",
      "agent_backgrounded",
      "text_delta",
      "thinking_delta",
      "agent_end",
    ]);
    expect(frames.every((frame) => frame.producer?.kind === "host" && !frame.runId)).toBe(true);
    const forwarded = f.events.find(
      (event) => event.type === "text_delta" && event.agentId === "background-child",
    )!;
    expect(forwarded.outputOriginCursor).toBe(origin);
    expect(forwarded.outputCursor).not.toBe(origin);
    expect(frames[2].event?.outputOriginCursor).toBe(origin);
    for (const event of f.events.filter((event) => "agentId" in event)) {
      expect(event.outputCursor).toEqual(expect.any(String));
      expect(
        readOutputJournal(f.root, f.id, {
          after: event.outputCursor,
          through: event.outputCursor,
        }).status,
      ).toBe("ok");
    }
    expect(f.manager.readSessionState(f.id)?.runId).toBe(nextRunId);
    expect(f.manager.readSessionState(f.id)?.outputRecoveryIncomplete).not.toBe(true);
  });

  test("child Todos and Goal progress persist without changing parent run state", () => {
    const f = fixture();
    const parentTasks: TaskInfo[] = [{ id: "parent-task", subject: "Parent", status: "pending" }];
    const childTasks: TaskInfo[] = [{ id: "child-task", subject: "Child", status: "completed" }];
    f.wrapped({ type: "task_update", tasks: parentTasks });
    f.wrapped(childStart);
    f.wrapped({ type: "task_update", agentId: "background-child", tasks: childTasks });
    f.wrapped({
      type: "goal_progress",
      agentId: "background-child",
      goalId: "child-goal",
      status: "met",
      round: 2,
    });
    expect(f.todoSnapshots).toEqual([parentTasks]);
    expect(
      f.session.transcript.getEvents().filter((event) => event.type === "goal_progress"),
    ).toEqual([]);
    const replay = readOutputJournal(f.root, f.id).frames.map((frame) => frame.event);
    expect(replay).toContainEqual(
      expect.objectContaining({
        type: "task_update",
        agentId: "background-child",
        tasks: childTasks,
      }),
    );
    expect(replay).toContainEqual(
      expect.objectContaining({
        type: "goal_progress",
        agentId: "background-child",
        goalId: "child-goal",
      }),
    );
  });

  test("a child title matching the parent title remains durable after a successor run", () => {
    const f = fixture();
    f.wrapped(childStart);
    f.wrapped.finish();
    f.nextRun();
    f.manager.updateSessionState(f.id, { title: "Shared title" });
    f.wrapped({
      type: "session_title",
      sessionId: "background-child",
      agentId: "background-child",
      title: "Shared title",
    });
    expect(f.events.at(-1)?.outputCursor).toEqual(expect.any(String));
    expect(readOutputJournal(f.root, f.id).frames.at(-1)?.event).toMatchObject({
      type: "session_title",
      sessionId: "background-child",
      agentId: "background-child",
      title: "Shared title",
    });
  });

  test("a child journal failure fences the same Session after its parent run was replaced", () => {
    const f = fixture();
    f.wrapped(childStart);
    f.wrapped.finish();
    const nextRunId = f.nextRun();
    truncateSync(f.journal, 0);
    expect(() =>
      f.wrapped({ type: "text_delta", agentId: "background-child", text: "cannot persist" }),
    ).toThrow();
    const state = f.manager.readSessionState(f.id);
    expect(state?.runId).toBe(nextRunId);
    expect(state?.outputRecoveryIncomplete).toBe(true);
    expect(() =>
      f.wrapped({
        type: "agent_end",
        agentId: "background-child",
        description: "Check the message",
        text: "must not publish success",
      }),
    ).toThrow("incomplete");
    expect(f.events.at(-1)?.type).toBe("agent_start");
  });

  test("a late child cannot recreate its deleted parent Session", () => {
    const f = fixture();
    f.wrapped(childStart);
    f.wrapped.finish();
    rmSync(f.directory, { recursive: true });
    expect(() =>
      f.wrapped({ type: "text_delta", agentId: "background-child", text: "orphan output" }),
    ).toThrow();
    expect(existsSync(f.directory)).toBe(false);
    expect(f.events.at(-1)?.type).toBe("agent_start");
  });

  test("a late child rejects a copied replacement without changing its state or journal", () => {
    const f = fixture();
    f.wrapped(childStart);
    f.wrapped.finish();
    const original = join(f.root, "original-parent");
    renameSync(f.directory, original);
    cpSync(original, f.directory, { recursive: true });
    const stateBefore = readFileSync(join(f.directory, "state.json"));
    const journalBefore = readFileSync(f.journal);
    expect(() =>
      f.wrapped({ type: "text_delta", agentId: "background-child", text: "wrong incarnation" }),
    ).toThrow();
    expect(readFileSync(join(f.directory, "state.json"))).toEqual(stateBefore);
    expect(readFileSync(f.journal)).toEqual(journalBefore);
    expect(f.manager.readSessionState(f.id)?.outputRecoveryIncomplete).not.toBe(true);
  });

  test("ephemeral child output remains process local after parent finalization", () => {
    const f = fixture({ ephemeral: true });
    f.wrapped(childStart);
    f.wrapped.finish();
    f.wrapped({ type: "text_delta", agentId: "background-child", text: "private late output" });
    f.wrapped({ type: "thinking_delta", agentId: "background-child", text: "private thinking" });
    f.wrapped({
      type: "agent_end",
      agentId: "background-child",
      description: "Check the message",
    });
    expect(f.events.slice(1).map((event) => event.type)).toEqual([
      "agent_start",
      "text_delta",
      "thinking_delta",
      "agent_end",
    ]);
    expect(f.events.every((event) => !event.outputCursor)).toBe(true);
    expect(existsSync(f.directory)).toBe(false);
    expect(readOutputJournal(f.root, f.id).status).toBe("unavailable");
  });

  test("consumer callback failures do not mark durable output as damaged", () => {
    for (const route of ["child", "parent", "finish", "control-flush"] as const) {
      let throwFromConsumer = false;
      const f = fixture({
        onStream() {
          if (throwFromConsumer) throw new Error("UI callback failed");
        },
      });
      throwFromConsumer = true;
      if (route === "child") expect(() => f.wrapped(childStart)).toThrow("UI callback failed");
      else if (route === "parent")
        expect(() => f.wrapped({ type: "error", error: "parent control event" })).toThrow(
          "UI callback failed",
        );
      else {
        f.wrapped({ type: "text_delta", text: "durable before consumer failure" });
        if (route === "finish") f.wrapped.finish();
        else
          expect(() => f.wrapped({ type: "error", error: "flush prior output" })).toThrow(
            "UI callback failed",
          );
      }
      throwFromConsumer = false;
      expect(f.manager.readSessionState(f.id)?.outputRecoveryIncomplete).not.toBe(true);
      expect(readOutputJournal(f.root, f.id).status).toBe("ok");
    }
  });
});
