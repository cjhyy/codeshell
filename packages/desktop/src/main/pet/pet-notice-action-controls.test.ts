import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BOUND_TIMEOUT_MS,
  createNoticeActionControls,
  createOwnerReplyHandling,
  lastUserMessageIn,
  type NoticeActionControlsDeps,
} from "./pet-notice-action-controls.js";
import { hostTimezoneOffsetMin } from "./pet-notice-policy.js";
import { localIsoTime, type ReplyItem } from "./pet-notice-reply-interpreter.js";
import type { NoticeActionRecord } from "./pet-notice-types.js";

function controls(
  options: { sessions?: Array<{ agentSessionId: string; runState?: string }> } = {},
) {
  const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
  const external: Array<{ method: string; args: unknown[] }> = [];
  const deps: NoticeActionControlsDeps = {
    worker: {
      subscribeOutbound: () => () => {},
      injectWorkerMessage: () => {},
      requestWorker: async (method, params) => {
        requests.push({ method, params });
        return { ok: true, result: { updated: true, deleted: true } };
      },
    },
    external: () => ({
      get: () => ({}),
      isSessionRunning: () => false,
      getGoal: () => ({ goal: "x", goalId: "g", revision: 2, paused: true }),
      updateGoal: async (...args: unknown[]) => {
        external.push({ method: "updateGoal", args });
        return { updated: true };
      },
      deleteGoal: (...args: unknown[]) => {
        external.push({ method: "deleteGoal", args });
        return { cleared: true };
      },
      send: async () => undefined,
    }),
    sessions: () => options.sessions ?? [],
    longTasks: { get: () => undefined, control: async () => ({ ok: true }) },
    readEvents: async () => [],
    workspace: async () => undefined,
    openPath: async () => "",
    revealPath: () => {},
    openExternal: async () => {},
    locateSession: () => {},
  };
  const made = createNoticeActionControls(deps);
  return { made, requests, external, deps };
}

describe("notice item controls", () => {
  test("a native Session the catalog no longer lists is gone", () => {
    const { made } = controls({ sessions: [{ agentSessionId: "a", runState: "idle" }] });
    expect(made.sessionState("a", "native")).toBe("idle");
    expect(made.sessionState("deleted", "native")).toBe("missing");
  });

  test("a paused Goal resumes through its own control, fenced by id and revision", async () => {
    const { made, requests, external } = controls();
    expect(await made.resumeGoal("a", "native", { goalId: "g", revision: 2 })).toBe(true);
    expect(requests).toEqual([
      {
        method: "agent/goalUpdate",
        params: { sessionId: "a", paused: false, expectedGoalId: "g", expectedRevision: 2 },
      },
    ]);
    expect(await made.resumeGoal("x", "external", { goalId: "g", revision: 2 })).toBe(true);
    expect(external).toEqual([
      {
        method: "updateGoal",
        args: ["x", { paused: false, expectedGoalId: "g", expectedRevision: 2 }],
      },
    ]);
    expect(await made.goal("x", "external")).toEqual({ goalId: "g", revision: 2, paused: true });
  });

  test("the last user message skips injected and non-user messages", () => {
    const message = (data: Record<string, unknown>) => ({ type: "message", data });
    expect(
      lastUserMessageIn([
        message({ role: "user", content: "把登录页做完" }),
        message({ role: "assistant", content: "好" }),
        message({ role: "user", content: "继续", injected: true }),
        message({ role: "user", content: [{ type: "text", text: "policy" }], authority: "policy" }),
      ]),
    ).toBe("把登录页做完");
    expect(lastUserMessageIn([])).toBeUndefined();
  });
});

describe("owner notice reply controls", () => {
  test("a fresh external selection interprets defer with the owner's clock and executes it", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "notice-reply-controls-"));
    try {
      const settingsDir = join(cwd, ".code-shell");
      await mkdir(settingsDir);
      const select = (model: string) =>
        writeFile(
          join(settingsDir, "settings.json"),
          JSON.stringify({ sessionDefaults: { model } }),
        );
      await select("codex/gpt-6.1-sol");
      const now = Date.UTC(2023, 10, 14, 4);
      const nextMorning = new Date(now);
      nextMorning.setDate(nextMorning.getDate() + 1);
      nextMorning.setHours(9, 0, 0, 0);
      const until = nextMorning.getTime();
      const record: NoticeActionRecord = {
        recordId: "brief-one",
        kind: "brief.evening",
        createdAt: now,
        target: { kind: "owner" },
        facts: { summary: "今天的工作已完成" },
        actions: { code: "AAAAAAAAAAAA", family: "notice", expiresAt: now + 2 * 86_400_000 },
      };
      const items: ReplyItem[] = [
        {
          ordinal: 1,
          ref: record.recordId,
          kind: "notice",
          text: record.facts.summary!,
          actions: ["defer"],
        },
      ];
      const selected: string[] = [];
      let unavailable = false;
      const deferred: Array<{ code: string; until?: number }> = [];
      const errors: unknown[] = [];
      const { deps, requests, external } = controls();
      const handling = createOwnerReplyHandling({
        ...deps,
        cwd,
        now: () => now,
        router: {
          actionRecord: () => record,
          openActionItems: () => [record],
          useAction: async () => undefined,
          deferNotice: async (code, requestedUntil) => {
            deferred.push({ code, until: requestedUntil });
            return { ok: true, until: requestedUntil! };
          },
        },
        externalReplyModel: async (model, { user }) => {
          selected.push(model);
          if (unavailable) throw new Error("External runtime unavailable");
          expect(JSON.parse(user)).toMatchObject({
            message: "明早再说",
            now: localIsoTime(now, hostTimezoneOffsetMin(now)),
            items: [{ actions: ["defer"] }],
          });
          await select("claude-code/sonnet");
          return JSON.stringify({
            kind: "resolve",
            item: 1,
            action: "defer",
            until: new Date(until).toISOString(),
            explicit: true,
          });
        },
        onError: (error) => errors.push(error),
      });
      const result = await handling.interpret("明早再说", items, { bound: true });
      expect(result).toEqual({ kind: "resolve", item: 1, action: "defer", until, explicit: true });
      expect(selected).toEqual(["codex/gpt-6.1-sol"]);
      expect(
        await handling.actions.execute({ code: record.actions.code, action: "defer", until }),
      ).toBe("好，明天 09:00 再说。");
      expect(deferred).toEqual([{ code: record.actions.code, until }]);
      await handling.interpret("明早再说", items, { bound: false });
      expect(selected).toEqual(["codex/gpt-6.1-sol", "claude-code/sonnet"]);
      expect(errors).toEqual([]);
      unavailable = true;
      expect(await handling.interpret("明早再说", items, { bound: false })).toBeUndefined();
      expect(selected).toEqual(["codex/gpt-6.1-sol", "claude-code/sonnet", "claude-code/sonnet"]);
      expect(errors).toHaveLength(1);
      expect(errors[0]).toEqual(new Error("External runtime unavailable"));
      expect(requests).toEqual([]);
      expect(external).toEqual([]);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("a bound reply tries only the first model in its eight-second budget", async () => {
    const called: number[] = [];
    const { deps } = controls();
    const handling = createOwnerReplyHandling({
      ...deps,
      cwd: "/unused",
      router: {
        actionRecord: () => undefined,
        openActionItems: () => [],
        useAction: async () => undefined,
      },
      models: [
        async () => {
          called.push(1);
          return "invalid";
        },
        async () => {
          called.push(2);
          return '{"kind":"unrelated"}';
        },
      ],
      onError: () => {},
    });
    expect(BOUND_TIMEOUT_MS).toBe(8_000);
    expect(await handling.interpret("你好", [], { bound: true })).toBeUndefined();
    expect(called).toEqual([1]);
    expect(await handling.interpret("你好", [], { bound: false })).toEqual({ kind: "unrelated" });
    expect(called).toEqual([1, 1, 2]);
  });
});
