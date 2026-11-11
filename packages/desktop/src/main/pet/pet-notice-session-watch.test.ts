import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { PetLongTask } from "@cjhyy/code-shell-pet";
import type { PetHostActionExecutor } from "./pet-dispatch-service.js";
import type { SessionWatchHostDeps } from "./pet-notice-session-watch.js";
import {
  NOW,
  SID,
  cleanupNoticeEnv,
  env,
  harness,
  longTask,
  resetNoticeEnv,
  settle,
  type Harness,
} from "./test-utils/notice-wiring-harness.js";

let current: Harness | undefined;

beforeEach(resetNoticeEnv);

afterEach(async () => {
  await cleanupNoticeEnv(current);
  current = undefined;
});

const ROUTE = {
  kind: "im-gateway" as const,
  channel: "lark",
  target: "chat-9",
  senderId: "owner-9",
  isDirectMessage: true,
};
const CONTEXT = { originClientMessageId: "im-msg-1", requestedAt: NOW, completionTarget: ROUTE };

interface WatchFixture {
  watch: PetHostActionExecutor;
  taskWatches: unknown[];
  goal: { paused?: boolean } | undefined;
  /** Called on every catalog refresh (to model a Session ending meanwhile). */
  onRefresh?: (count: number) => void;
}

function watchAction(h: Harness): WatchFixture {
  let refreshes = 0;
  const fixture: WatchFixture = {
    taskWatches: [],
    goal: undefined,
    watch: undefined as unknown as PetHostActionExecutor,
  };
  const host: SessionWatchHostDeps = {
    refreshCatalog: async () => {
      refreshes += 1;
      fixture.onRefresh?.(refreshes);
    },
    sessions: () => h.sessions,
    longTasks: {
      activeForSession: (id) =>
        h.tasks.find(
          (task) =>
            task.sessionId === id && !["completed", "failed", "cancelled"].includes(task.status),
        ),
      watchSession: async (input) => {
        fixture.taskWatches.push(input);
        const task = h.tasks.find((candidate) => candidate.sessionId === input.sessionId)!;
        return { task, alreadyWatching: false };
      },
      reconcileNow: async () => undefined,
    },
    goals: { readActiveGoal: () => fixture.goal },
  };
  fixture.watch = h.wiring.sessionWatch(host);
  return fixture;
}

const watchRules = (h: Harness) =>
  h.wiring.ruleStore.list().filter((rule) => rule.createdBy === "watch-session");

describe("WatchSession arms a notice rule for the asking conversation", () => {
  test("a rule addressed to the conversation, for done / failed / blocked; no long task", async () => {
    current = harness();
    const fixture = watchAction(current);
    const result = await fixture.watch({ sessionId: SID }, CONTEXT);
    expect(result).toMatchObject({ watching: true, alreadyWatching: false, title: "修登录" });
    const [rule] = watchRules(current);
    expect(rule).toMatchObject({
      origin: "user",
      createdBy: "watch-session",
      state: "active",
      channel: "lark",
      target: { kind: "route", route: ROUTE },
      when: {
        kind: "session",
        sessionId: SID,
        events: ["done", "failed", "blocked"],
        scope: "turn",
      },
    });
    expect(result.ruleId).toBe(rule!.id);
    expect(fixture.taskWatches).toEqual([]);
    expect(current.tasks).toEqual([]);
  });

  test("asking again is already watching (no second rule)", async () => {
    current = harness();
    const fixture = watchAction(current);
    await fixture.watch({ sessionId: SID }, CONTEXT);
    const again = await fixture.watch({ sessionId: SID }, CONTEXT);
    expect(again).toMatchObject({ watching: true, alreadyWatching: true });
    expect(watchRules(current)).toHaveLength(1);
  });

  test("an active Goal makes the rule wait for the Goal", async () => {
    current = harness();
    const fixture = watchAction(current);
    fixture.goal = {};
    await fixture.watch({ sessionId: SID }, CONTEXT);
    expect(watchRules(current)[0]!.when).toMatchObject({ scope: "goal" });
  });

  test("a Session that already ended is reported as ended, with no rule", async () => {
    current = harness();
    current.sessions[0] = {
      ...current.sessions[0]!,
      runState: "terminal",
      terminal: { status: "completed", at: NOW - 5_000 },
    } as never;
    const result = await watchAction(current).watch({ sessionId: SID }, CONTEXT);
    expect(result).toEqual({
      watching: false,
      title: "修登录",
      status: "completed",
      endedAt: NOW - 5_000,
    });
    expect(watchRules(current)).toEqual([]);
  });

  test("a Session that ended while the rule was being armed: ended, and the rule withdrawn", async () => {
    current = harness();
    const fixture = watchAction(current);
    fixture.onRefresh = (count) => {
      if (count === 2)
        current!.sessions[0] = {
          ...current!.sessions[0]!,
          runState: "terminal",
          terminal: { status: "completed", at: NOW + 1 },
        } as never;
    };
    const result = await fixture.watch({ sessionId: SID }, CONTEXT);
    expect(result).toMatchObject({ watching: false, status: "completed" });
    expect(watchRules(current).map((rule) => rule.state)).toEqual(["cancelled"]);
  });

  test("a turn completed after the watch goes back to that conversation, as its answer", async () => {
    current = harness();
    await watchAction(current).watch({ sessionId: SID }, CONTEXT);
    env.clock = NOW + 1_000;
    for (const event of [
      { type: "session_started", runId: "run-1", clientMessageId: "cm-1" },
      { type: "tool_use_start", toolCall: { id: "t1", toolName: "Bash", args: {} } },
      { type: "turn_complete", reason: "completed", text: "测试都过了", runId: "run-1" },
    ])
      current.observeSessionEvent(SID, event);
    await settle(() => current!.submitted.length > 0);
    await current.idle();
    expect(current.submitted).toHaveLength(1);
    expect(current.submitted[0]).toMatchObject({
      kind: "session.done",
      reply: true,
      target: { kind: "route", route: ROUTE },
    });
    expect(current.published).toEqual([
      expect.objectContaining({
        type: "pet.task.completed",
        target: { channel: "lark", target: "chat-9" },
      }),
    ]);
    // A turn rule is spent by its done.
    expect(watchRules(current).map((rule) => rule.state)).toEqual(["spent"]);
  });

  test("a decision in the watched Session is prompted in that conversation", async () => {
    current = harness();
    await watchAction(current).watch({ sessionId: SID }, CONTEXT);
    const delivery = current.wiring.decisions.deliveryFor(SID, undefined);
    expect(delivery).toMatchObject({
      target: { kind: "route", route: ROUTE },
      channel: "lark",
      reply: true,
    });
  });

  test("a delegated Session keeps its long task as the reporter", async () => {
    current = harness();
    const task: PetLongTask = longTask({ status: "running" });
    current.tasks.push(task);
    const fixture = watchAction(current);
    const result = await fixture.watch({ sessionId: SID }, CONTEXT);
    expect(result).toMatchObject({ watching: true, taskId: task.id });
    expect(fixture.taskWatches).toEqual([
      expect.objectContaining({ sessionId: SID, completionTarget: ROUTE }),
    ]);
    expect(watchRules(current)).toEqual([]);
  });

  test("a tailed CLI rollout (no rules) keeps the long-task watch it always had", async () => {
    current = harness();
    current.sessions[0] = { ...current.sessions[0]!, external: true } as never;
    // No active task: the real watchSession creates one; the fixture answers with this row.
    current.tasks.push(longTask({ status: "completed" }));
    const fixture = watchAction(current);
    const result = await fixture.watch({ sessionId: SID }, CONTEXT);
    expect(result).toMatchObject({ watching: true });
    expect(fixture.taskWatches).toEqual([
      expect.objectContaining({ sessionId: SID, completionTarget: ROUTE }),
    ]);
    expect(watchRules(current)).toEqual([]);
  });

  test("an idle Session is refused, as before", async () => {
    current = harness();
    current.sessions[0] = { ...current.sessions[0]!, runState: "idle" } as never;
    await expect(watchAction(current).watch({ sessionId: SID }, CONTEXT)).rejects.toThrow(
      "not active",
    );
    expect(watchRules(current)).toEqual([]);
  });

  test("without the IM turn's route there is nothing to watch for", async () => {
    current = harness();
    await expect(
      watchAction(current).watch(
        { sessionId: SID },
        { originClientMessageId: "m", requestedAt: NOW },
      ),
    ).rejects.toThrow("完成回告路由");
  });
});
