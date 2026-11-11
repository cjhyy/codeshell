import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NoticeActionsInput } from "./pet-notice-action-codes";
import {
  containedFile,
  createNoticeActionExecutor,
  type NoticeActionControls,
  type NoticeActionRequest,
  type NoticeHandoff,
  type NoticeLiveGoal,
} from "./pet-notice-actions";
import { PetNoticeLedger } from "./pet-notice-ledger";
import {
  PetNoticeRouter,
  type NoticeImSendResult,
  type NoticeSubmission,
} from "./pet-notice-router";

const HOUR = 60 * 60_000;
const NOON = Date.UTC(2026, 10, 9, 4, 0, 0);

let dir: string;
beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), "pet-notice-actions-")));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

interface Calls {
  sent: Array<{ sessionId: string; runtime: string; text: string; displayText: string }>;
  deleted: Array<{ sessionId: string; runtime: string; goalId: string; revision: number }>;
  tasks: Array<{ taskId: string; action: string }>;
  opened: string[];
  links: string[];
  located: string[];
  resumed: Array<{ sessionId: string; runtime: string; goalId: string; revision: number }>;
  revealed: string[];
}

function harness(options: { imAccepted?: boolean } = {}) {
  const clock = { now: NOON };
  const ledger = new PetNoticeLedger({ path: join(dir, "notices.json"), now: () => clock.now });
  const im: Array<{ body: string; nonDirect?: string }> = [];
  const desktop: string[] = [];
  const router = new PetNoticeRouter({
    source: {
      getSnapshot: () => ({
        version: 1,
        generation: 1,
        workerState: "active",
        observedAt: 0,
        sessions: [],
        pending: [],
      }),
      subscribe: () => () => {},
    },
    receipts: { has: () => false, mark: () => {} },
    now: () => clock.now,
    ledger,
    presence: { isPresent: () => false },
    settings: () => ({ quietHours: null }),
    imChannels: () => ({ wechat: "ready" }),
    lastInboundChannel: () => "wechat",
    supportsIdempotentSend: () => true,
    timezoneOffsetMin: () => 480,
    outlets: {
      desktop: (_notice, body) => desktop.push(body),
      im: async (_channel, _target, body, _key, payload): Promise<NoticeImSendResult> => {
        im.push({ body, ...(payload.nonDirectBody ? { nonDirect: payload.nonDirectBody } : {}) });
        return options.imAccepted === false
          ? { accepted: false, error: "offline" }
          : { accepted: true };
      },
    },
    log: () => {},
  });
  const calls: Calls = {
    sent: [],
    deleted: [],
    tasks: [],
    opened: [],
    links: [],
    located: [],
    resumed: [],
    revealed: [],
  };
  const state: {
    goal: NoticeLiveGoal | null | Error;
    session: "idle" | "running" | "missing";
    tasks: Record<string, string>;
    lastUser?: string;
    workspace?: string;
  } = { goal: { goalId: "goal-1", revision: 3, paused: false }, session: "idle", tasks: {} };
  const controls: NoticeActionControls = {
    goal: async () => {
      if (state.goal instanceof Error) throw state.goal;
      return state.goal;
    },
    sessionState: () => state.session,
    send: async (sessionId, runtime, input) => {
      calls.sent.push({ sessionId, runtime, text: input.text, displayText: input.displayText });
    },
    deleteGoal: async (sessionId, runtime, expected) => {
      calls.deleted.push({ sessionId, runtime, ...expected });
      return true;
    },
    resumeGoal: async (sessionId, runtime, expected) => {
      calls.resumed.push({ sessionId, runtime, ...expected });
      return true;
    },
    task: (taskId) => (state.tasks[taskId] ? { status: state.tasks[taskId]! } : undefined),
    controlTask: async (taskId, action) => {
      calls.tasks.push({ taskId, action });
      return { ok: true };
    },
    lastUserMessage: async () => state.lastUser,
    workspace: async () => state.workspace,
    openPath: async (path) => void calls.opened.push(path),
    revealPath: (path) => void calls.revealed.push(path),
    openExternal: async (url) => void calls.links.push(url),
    locateSession: (sessionId) => void calls.located.push(sessionId),
  };
  const executor = createNoticeActionExecutor({ router, controls, now: () => clock.now });
  const run = (code: string, action: NoticeActionRequest["action"], extra = {}) =>
    executor.execute({ code, action, ...extra });

  let seq = 0;
  async function notify(
    actions: Partial<NoticeActionsInput> & Pick<NoticeActionsInput, "family">,
    patch: Partial<NoticeSubmission> = {},
  ): Promise<string> {
    seq += 1;
    await router.submit({
      kind: actions.family === "open" ? "session.done" : "session.blocked",
      priority: "P0",
      dedupeKey: `notice-${seq}`,
      sessionId: "work-1",
      ruleIds: ["rule-1"],
      facts: { title: "登录页", question: "用哪个方案？" },
      attention: "always",
      channel: "auto",
      target: { kind: "owner" },
      actions: { sessionId: "work-1", runtime: "native", ...actions },
      ...patch,
    });
    await ledger.load();
    return ledger.byDedupeKey(`notice-${seq}`)!.actions!.code;
  }
  return { clock, ledger, router, im, desktop, calls, state, run, notify };
}

describe("arming a notice", () => {
  test("the IM text ends with a plain reply line; the desktop and group text do not", async () => {
    const h = harness();
    const code = await h.notify({ family: "goal", goalId: "goal-1", revision: 3 });
    expect(h.im[0]!.body).toBe(
      "「登录页」需要你决定：用哪个方案？\n直接回我要对它说的话就行；也可以让它停下，或交给 Mimi。",
    );
    expect(h.im[0]!.body).not.toContain(code);
    expect(h.im[0]!.nonDirect).toBe("「登录页」需要你决定：用哪个方案？");
    expect(h.desktop).toEqual([]);
    expect(h.ledger.byActionCode(code)!.actions).toMatchObject({
      family: "goal",
      sessionId: "work-1",
      goalId: "goal-1",
      revision: 3,
      expiresAt: NOON + 24 * HOUR,
      slot: { channel: "wechat", ordinal: 1 },
    });
  });

  test("a pre-written body keeps its text and gains the reply line", async () => {
    const h = harness();
    await h.notify(
      { family: "failure", retry: true },
      { kind: "session.failed", body: "Mimi：这次没做完。" },
    );
    expect(h.im[0]!.body).toBe("Mimi：这次没做完。\n要重试，还是交给 Mimi？直接回我就行。");
  });

  test("open items in one chat are numbered ①②; one alone carries no number", async () => {
    const h = harness();
    const other = (sessionId: string) => ({ sessionId });
    const first = await h.notify({ family: "goal", goalId: "goal-1", revision: 3 });
    const second = await h.notify(
      { family: "limit", reason: "limit", ...other("work-2") },
      other("work-2"),
    );
    expect(h.im[0]!.body.startsWith("「登录页」")).toBe(true);
    expect(h.im[1]!.body.startsWith("② 「登录页」")).toBe(true);
    expect(h.ledger.byActionCode(second)!.actions!.slot).toEqual({ channel: "wechat", ordinal: 2 });
    // The first is used: its number is free again; the second keeps ②.
    await h.run(first, "reply", { text: "好" });
    const third = await h.notify({ family: "failure", ...other("work-3") }, other("work-3"));
    expect(h.im[2]!.body.startsWith("① 「登录页」")).toBe(true);
    expect(h.ledger.byActionCode(third)!.actions!.slot!.ordinal).toBe(1);
    expect(h.router.openActionItems("wechat").map((item) => item.actions.code)).toEqual([
      second,
      third,
    ]);
    expect(h.router.openActionItems("lark")).toEqual([]);
  });

  test("a Session that moved on closes its items; a result stays openable for 2 hours", async () => {
    const h = harness();
    const goal = await h.notify({ family: "goal", goalId: "goal-1", revision: 3 });
    // A newer notice about the same Session closes the older item.
    const failure = await h.notify({ family: "failure", retry: true });
    expect(h.ledger.byActionCode(goal)!.actions!.closedAt).toBe(NOON);
    expect(await h.run(goal, "reply", { text: "好" })).toContain("已经过时了");
    // Another run of the Session closes goal / limit / failure items, not results.
    const result = await h.notify({
      family: "open",
      artifacts: [{ kind: "file", path: "/w/a.ts" }],
    });
    expect(h.ledger.byActionCode(failure)!.actions!.closedAt).toBe(NOON);
    const limit = await h.notify(
      { family: "limit", reason: "limit", sessionId: "work-2" },
      { sessionId: "work-2" },
    );
    await h.router.sessionRunStarted("work-2");
    expect(h.ledger.byActionCode(limit)!.actions!.closedAt).toBe(NOON);
    await h.router.sessionRunStarted("work-1");
    expect(h.router.openActionItems("wechat").map((item) => item.actions.code)).toEqual([result]);
    h.clock.now += 2 * HOUR;
    expect(h.router.openActionItems("wechat")).toEqual([]);
    expect(await h.run(result, "open")).toContain("已过期");
  });

  test("an item not delivered yet is not open in any chat", async () => {
    const h = harness({ imAccepted: false });
    await h.notify({ family: "goal", goalId: "goal-1", revision: 3 });
    expect(h.router.openActionItems("wechat")).toEqual([]);
  });
});

describe("recheck before acting", () => {
  test("reply sends the owner's words once; a second one is refused", async () => {
    const h = harness();
    const code = await h.notify({ family: "goal", goalId: "goal-1", revision: 3 });
    expect(await h.run(code, "reply", { text: "用方案二" })).toBe(
      "已把你的回复发给会话，它会接着做。",
    );
    expect(h.calls.sent).toEqual([
      { sessionId: "work-1", runtime: "native", text: "用方案二", displayText: "用方案二" },
    ]);
    expect(h.ledger.byActionCode(code)?.actions?.usedAt).toBe(NOON);
    expect(await h.run(code, "reply", { text: "再来一次" })).toBe(
      "这件事已经处理过了，没有再执行。",
    );
    expect(h.calls.sent).toHaveLength(1);
  });

  test("reply without words asks for them", async () => {
    const h = harness();
    const code = await h.notify({ family: "goal", goalId: "goal-1", revision: 3 });
    expect(await h.run(code, "reply")).toContain("直接回我那句话");
    expect(h.calls.sent).toHaveLength(0);
  });

  test("an expired item does nothing", async () => {
    const h = harness();
    const code = await h.notify({ family: "goal", goalId: "goal-1", revision: 3 });
    h.clock.now += 24 * HOUR;
    expect(await h.run(code, "stop")).toBe("这件事已过期（24 小时内有效），没有执行。");
    expect(h.calls.deleted).toHaveLength(0);
  });

  test("a Goal that changed (revision, identity, unreadable) is left alone", async () => {
    const h = harness();
    const code = await h.notify({ family: "goal", goalId: "goal-1", revision: 3 });
    h.state.goal = { goalId: "goal-1", revision: 4, paused: true };
    expect(await h.run(code, "reply", { text: "好" })).toBe("这个 Goal 已经变了，没有动它。");
    h.state.goal = { goalId: "goal-2", revision: 3, paused: false };
    expect(await h.run(code, "stop")).toBe("这个 Goal 已经变了，没有动它。");
    h.state.goal = new Error("worker gone");
    expect(await h.run(code, "reply", { text: "好" })).toContain("读不到这个 Goal");
    expect(h.calls.sent).toHaveLength(0);
    expect(h.calls.deleted).toHaveLength(0);
    expect(h.ledger.byActionCode(code)?.actions?.usedAt).toBeUndefined();
  });

  test("a Session running again or gone is left alone", async () => {
    const h = harness();
    const code = await h.notify({ family: "goal", goalId: "goal-1", revision: 3 });
    h.state.session = "running";
    expect(await h.run(code, "reply", { text: "好" })).toBe("会话已经又在跑了，没有动它。");
    h.state.session = "missing";
    expect(await h.run(code, "reply", { text: "好" })).toContain("这个会话不在了");
    expect(h.calls.sent).toHaveLength(0);
  });

  test("an action the item does not offer, or an unknown item, does nothing", async () => {
    const h = harness();
    const code = await h.notify({ family: "goal", goalId: "goal-1", revision: 3 });
    expect(await h.run(code, "retry")).toBe("这件事不能这样处理，没有执行。");
    expect(await h.run("FFFFFFFFFFFF", "stop")).toBe("这件事已经结束了，没有执行。");
    expect(h.calls.deleted).toHaveLength(0);
  });

  test("using an item withdraws its queued copy", async () => {
    const h = harness({ imAccepted: false });
    const code = await h.notify({ family: "goal", goalId: "goal-1", revision: 3 });
    expect(h.ledger.byActionCode(code)?.delivery?.status).toBe("queued");
    await h.run(code, "reply", { text: "好" });
    expect(h.ledger.byActionCode(code)?.delivery).toMatchObject({
      status: "revoked",
      error: "action-used",
    });
  });
});

describe("actions", () => {
  test("stop cancels the long task driving the Session", async () => {
    const h = harness();
    h.state.tasks["task-1"] = "running";
    const code = await h.notify({
      family: "goal",
      goalId: "goal-1",
      revision: 3,
      taskId: "task-1",
    });
    expect(await h.run(code, "stop")).toBe("已停止这个任务，不会再继续。");
    expect(h.calls.tasks).toEqual([{ taskId: "task-1", action: "cancel" }]);
    expect(h.calls.deleted).toHaveLength(0);
  });

  test("stop clears the Goal only at the revision that stopped (external runtime)", async () => {
    const h = harness();
    const code = await h.notify({
      family: "goal",
      runtime: "external",
      goalId: "goal-1",
      revision: 3,
    });
    expect(await h.run(code, "stop")).toBe("已停止这个 Goal，不会再自己继续。");
    expect(h.calls.deleted).toEqual([
      { sessionId: "work-1", runtime: "external", goalId: "goal-1", revision: 3 },
    ]);
  });

  test("continue after a limit stop sends the next turn", async () => {
    const h = harness();
    h.state.goal = null;
    const code = await h.notify({ family: "limit", reason: "limit" });
    expect(h.im[0]!.body).toContain("要继续、停下，还是交给 Mimi？直接回我就行。");
    expect(await h.run(code, "continue")).toBe("已让会话接着做。");
    expect(h.calls.sent).toEqual([
      {
        sessionId: "work-1",
        runtime: "native",
        text: "请从上次停下的地方继续。",
        displayText: "继续",
      },
    ]);
  });

  test("continue resumes a paused Goal through its own control (native and external)", async () => {
    for (const runtime of ["native", "external"] as const) {
      const h = harness();
      h.state.goal = { goalId: "goal-1", revision: 4, paused: true };
      const code = await h.notify({ family: "limit", reason: "limit", runtime });
      expect(await h.run(code, "continue")).toBe("已让这个 Goal 接着做。");
      expect(h.calls.resumed).toEqual([
        { sessionId: "work-1", runtime, goalId: "goal-1", revision: 4 },
      ]);
      expect(h.calls.sent).toEqual([]);
    }
  });

  test("continue after an exhausted Goal refuses once a new Goal was set", async () => {
    const h = harness();
    h.state.goal = { goalId: "goal-9", revision: 1, paused: false };
    const code = await h.notify({ family: "limit", reason: "goal_exhausted", goalId: "goal-1" });
    expect(await h.run(code, "continue")).toBe("这个 Goal 已经变了，没有动它。");
    h.state.goal = null;
    expect(await h.run(code, "continue")).toContain("原来的 Goal 已用完额度");
    expect(h.calls.sent).toHaveLength(1);
  });

  test("retry retries a failed task, or resends the last message, or says it cannot", async () => {
    const h = harness();
    h.state.tasks["task-1"] = "failed";
    const task = await h.notify({ family: "failure", retry: true, taskId: "task-1" });
    expect(await h.run(task, "retry")).toBe("已重新开始这个任务。");
    expect(h.calls.tasks).toEqual([{ taskId: "task-1", action: "retry" }]);

    h.state.tasks["task-2"] = "running";
    const moved = await h.notify({ family: "failure", retry: true, taskId: "task-2" });
    expect(await h.run(moved, "retry")).toContain("不是失败状态");

    h.state.goal = null;
    h.state.lastUser = "把登录页做完";
    const plain = await h.notify({ family: "failure", retry: true });
    expect(await h.run(plain, "retry")).toBe("已把上一条消息重新发给会话。");
    expect(h.calls.sent.at(-1)).toMatchObject({ text: "把登录页做完" });

    h.state.lastUser = undefined;
    const none = await h.notify({ family: "failure", retry: true });
    expect(await h.run(none, "retry")).toContain("要交给 Mimi 处理吗");
  });

  test("handoff gives Mimi's turn the notice's data, once; never from a bound chat", async () => {
    const h = harness();
    const code = await h.notify({ family: "goal", goalId: "goal-1", revision: 3 });
    expect(await h.run(code, "handoff", { handoff: false })).toContain("/mimi");
    const reply = (await h.run(code, "handoff", { message: "你看着办" })) as NoticeHandoff;
    expect(reply.handoff).toContain('"ownerSaid":"你看着办"');
    expect(reply.handoff).toContain('"sessionId":"work-1"');
    expect(reply.handoff).toContain('"question":"用哪个方案？"');
    expect(reply.handoff).not.toContain(code);
    // Not used until Mimi's turn is dispatched; meanwhile nobody else takes it.
    expect(h.ledger.byActionCode(code)!.actions!.usedAt).toBeUndefined();
    expect(await h.run(code, "handoff")).toBe("这件事正在处理，请稍等。");
    reply.abandoned();
    const again = (await h.run(code, "handoff")) as NoticeHandoff;
    await again.dispatched();
    expect(h.ledger.byActionCode(code)!.actions!.usedAt).toBe(NOON);
    expect(await h.run(code, "handoff")).toBe("这件事已经处理过了，没有再执行。");
  });
});

describe("open", () => {
  async function workspace() {
    const root = join(dir, "ws");
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src", "a.ts"), "a");
    await writeFile(join(dir, "secret.txt"), "s");
    await symlink(join(dir, "secret.txt"), join(root, "src", "link.txt"));
    return root;
  }

  test("a file inside the workspace opens; outside or through a link only locates", async () => {
    const h = harness();
    h.state.workspace = await workspace();
    const inside = await h.notify({
      family: "open",
      artifacts: [{ kind: "file", path: join(h.state.workspace, "src", "a.ts") }],
    });
    expect(h.im.at(-1)!.body).toContain("想在电脑上打开结果就回我。");
    expect(await h.run(inside, "open")).toBe("在电脑上开好了。");
    expect(h.calls.opened).toEqual([join(h.state.workspace, "src", "a.ts")]);
    // open may repeat.
    expect(await h.run(inside, "open")).toBe("在电脑上开好了。");

    const escape = await h.notify({
      family: "open",
      artifacts: [{ kind: "file", path: join(h.state.workspace, "src", "link.txt") }],
    });
    expect(await h.run(escape, "open")).toContain("只在电脑上打开了这个会话");
    const outside = await h.notify({
      family: "open",
      artifacts: [{ kind: "file", path: join(dir, "secret.txt") }],
    });
    expect(await h.run(outside, "open")).toContain("只在电脑上打开了这个会话");
    expect(h.calls.opened).toHaveLength(2);
    expect(h.calls.located).toEqual(["work-1", "work-1"]);
  });

  test("scripts and launchers are shown in their folder, never opened", async () => {
    const h = harness();
    const root = join(dir, "ws");
    await mkdir(root, { recursive: true });
    for (const name of ["run.sh", "Start.command", "notes.md"])
      await writeFile(join(root, name), "x");
    h.state.workspace = root;
    for (const name of ["run.sh", "Start.command"]) {
      const code = await h.notify({
        family: "open",
        artifacts: [{ kind: "file", path: join(root, name) }],
      });
      expect(await h.run(code, "open")).toContain("所在的文件夹");
    }
    const doc = await h.notify({
      family: "open",
      artifacts: [{ kind: "file", path: join(root, "notes.md") }],
    });
    expect(await h.run(doc, "open")).toBe("在电脑上开好了。");
    expect(h.calls.revealed).toEqual([join(root, "run.sh"), join(root, "Start.command")]);
    expect(h.calls.opened).toEqual([join(root, "notes.md")]);
  });

  test("several items: listed when unclear, opened by index", async () => {
    const h = harness();
    const code = await h.notify({
      family: "open",
      artifacts: [
        { kind: "file", path: "/w/src/a.ts" },
        { kind: "url", url: "https://github.com/o/r/pull/1" },
      ],
    });
    expect(h.im.at(-1)!.body).toContain("（共 2 项）");
    expect(await h.run(code, "open")).toBe(
      [
        "这条有 2 项可以打开，要哪一个？",
        "1. 文件 a.ts",
        "2. 链接 https://github.com/o/r/pull/1",
      ].join("\n"),
    );
    expect(await h.run(code, "open", { index: 3 })).toContain("只有 2 项");
    expect(await h.run(code, "open", { index: 2 })).toBe("在电脑上开好了。");
    expect(h.calls.links).toEqual(["https://github.com/o/r/pull/1"]);
  });

  test("an unknown host asks first; confirm opens it once", async () => {
    const h = harness();
    const code = await h.notify({
      family: "open",
      artifacts: [{ kind: "url", url: "https://preview.example.com/x" }],
    });
    expect(await h.run(code, "confirm")).toBe("这件事不能这样处理，没有执行。");
    expect(await h.run(code, "open")).toBe("要打开 `preview.example.com` 吗？回我一声就打开。");
    expect(h.calls.links).toEqual([]);
    expect(h.ledger.byActionCode(code)!.actions!.confirm).toEqual({
      item: 1,
      expiresAt: NOON + 24 * HOUR,
    });
    expect(await h.run(code, "confirm")).toBe("在电脑上开好了。");
    expect(h.calls.links).toEqual(["https://preview.example.com/x"]);
    expect(await h.run(code, "confirm")).toBe("这件事不能这样处理，没有执行。");
  });

  test("a pending link confirmation expires", async () => {
    const h = harness();
    const code = await h.notify({
      family: "open",
      artifacts: [{ kind: "url", url: "https://preview.example.com/x" }],
    });
    h.clock.now += 1_000;
    await h.run(code, "open");
    h.clock.now += 24 * HOUR - 500;
    // The item itself expired first (24 h from the notice).
    expect(await h.run(code, "confirm")).toBe("这件事已过期（24 小时内有效），没有执行。");
    expect(h.calls.links).toEqual([]);
  });
});

describe("containedFile", () => {
  test("a regular file under the root, reached without links", async () => {
    const root = join(dir, "root");
    await mkdir(join(root, "a"), { recursive: true });
    await writeFile(join(root, "a", "f.txt"), "x");
    await symlink(join(root, "a"), join(root, "alias"));
    expect(await containedFile(root, join(root, "a", "f.txt"))).toBe(join(root, "a", "f.txt"));
    expect(await containedFile(root, join(root, "alias", "f.txt"))).toBeUndefined();
    expect(await containedFile(root, join(root, "a"))).toBeUndefined();
    expect(await containedFile(root, join(root, "..", "x"))).toBeUndefined();
    expect(await containedFile(root, join(root, "missing.txt"))).toBeUndefined();
    expect(await containedFile(root, "a/f.txt")).toBeUndefined();
  });
});
