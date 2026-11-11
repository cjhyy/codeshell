import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { BOUND_TIMEOUT_MS } from "./pet-notice-action-controls.js";
import { createNoticeActionExecutor, type NoticeActionControls } from "./pet-notice-actions.js";
import {
  interpretReply,
  parseInterpretation,
  type ReplyItem,
  type ReplyModel,
} from "./pet-notice-reply-interpreter.js";
import {
  OWNER_DM,
  SID,
  cleanupNoticeEnv,
  decisionRelay,
  env,
  harness,
  resetNoticeEnv,
  session,
  settle,
  upsertArgs,
  type Harness,
} from "./test-utils/notice-wiring-harness.js";
import { sessionRouteHandler } from "./session-bridge-wiring.js";

const ITEMS: ReplyItem[] = [
  {
    ordinal: 1,
    ref: "AAAAAAAAAAAA",
    kind: "question",
    text: "用哪个包管理器？",
    options: ["npm", "pnpm"],
    actions: ["answer", "skip"],
  },
  {
    ordinal: 2,
    ref: "BBBBBBBBBBBB",
    kind: "open",
    text: "做完了",
    artifacts: ["1. 文件 a.ts", "2. 链接 https://github.com/o/r/pull/1"],
    actions: ["open"],
  },
];

describe("parseInterpretation", () => {
  test("a resolve names an offered item, one of its actions, and valid details", () => {
    expect(
      parseInterpretation(
        '{"kind":"resolve","item":1,"action":"answer","choices":["pnpm"],"explicit":true}',
        ITEMS,
      ),
    ).toEqual({ kind: "resolve", item: 1, action: "answer", choices: ["pnpm"], explicit: true });
    expect(
      parseInterpretation(
        '```json\n{"kind":"resolve","item":2,"action":"open","index":2,"explicit":false}\n```',
        ITEMS,
      ),
    ).toEqual({ kind: "resolve", item: 2, action: "open", index: 2, explicit: false });
    expect(parseInterpretation('{"kind":"unrelated"}', ITEMS)).toEqual({ kind: "unrelated" });
    expect(parseInterpretation('{"kind":"ambiguous","question":"哪一个？"}', ITEMS)).toEqual({
      kind: "ambiguous",
      question: "哪一个？",
    });
  });

  test("free text is the owner's own: the whole message, or a verbatim part of it", () => {
    const free = (extra: string) =>
      parseInterpretation(
        `{"kind":"resolve","item":1,"action":"answer",${extra},"explicit":true}`,
        ITEMS,
        "  就用 pnpm 吧，谢谢 ",
      );
    expect(free('"useWholeMessage":true')).toMatchObject({ answer: "就用 pnpm 吧，谢谢" });
    expect(free('"answer":"用 pnpm"')).toMatchObject({ answer: "用 pnpm" });
    expect(free('"answer":"请使用 pnpm"')).toBeUndefined();
    expect(free('"useWholeMessage":false')).toBeUndefined();
  });

  test("anything not offered, or not the schema, is rejected", () => {
    for (const raw of [
      '{"kind":"resolve","item":3,"action":"open","explicit":true}',
      '{"kind":"resolve","item":1,"action":"approve","explicit":true}',
      '{"kind":"resolve","item":1,"action":"answer","choices":["yarn"],"explicit":true}',
      '{"kind":"resolve","item":1,"action":"answer","choices":["npm","pnpm"],"explicit":true}',
      '{"kind":"resolve","item":2,"action":"open","index":3,"explicit":true}',
      '{"kind":"resolve","item":1,"action":"skip"}',
      '{"kind":"resolve","item":1,"action":"skip","explicit":true,"scope":"session"}',
      '{"kind":"unrelated","note":"x"}',
      '{"kind":"ambiguous","question":""}',
      "好的，我来处理",
      "[]",
    ])
      expect(parseInterpretation(raw, ITEMS)).toBeUndefined();
  });
});

describe("interpretReply", () => {
  test("the auxiliary model first, then the main model; none valid means undefined", async () => {
    const calls: string[] = [];
    const down: ReplyModel = async () => {
      calls.push("aux");
      throw new Error("no aux model");
    };
    const invalid: ReplyModel = async () => {
      calls.push("invalid");
      return '{"kind":"resolve","item":9,"action":"open","explicit":true}';
    };
    const main: ReplyModel = async ({ user }) => {
      calls.push("main");
      expect(JSON.parse(user)).toEqual({ message: "打开第二个", items: ITEMS });
      return '{"kind":"resolve","item":2,"action":"open","index":2,"explicit":true}';
    };
    expect(
      await interpretReply({ message: "打开第二个", items: ITEMS, models: [down, invalid, main] }),
    ).toMatchObject({ item: 2, index: 2 });
    expect(calls).toEqual(["aux", "invalid", "main"]);
    expect(await interpretReply({ message: "x", items: ITEMS, models: [down, invalid] })).toBe(
      undefined,
    );
  });

  test("a model that does not answer in time is skipped", async () => {
    const slow: ReplyModel = ({ signal }) =>
      new Promise((_, reject) =>
        signal.addEventListener("abort", () => reject(new Error("aborted"))),
      );
    const quick: ReplyModel = async () => '{"kind":"unrelated"}';
    expect(
      await interpretReply({ message: "x", items: ITEMS, models: [slow, quick], timeoutMs: 20 }),
    ).toEqual({ kind: "unrelated" });
  });
});

let current: Harness | undefined;
beforeEach(resetNoticeEnv);
afterEach(async () => {
  await cleanupNoticeEnv(current);
  current = undefined;
});

/** A reply model scripted per test; records what it was shown. */
function model(answer: (items: ReplyItem[], message: string) => string) {
  const seen: Array<{ message: string; items: ReplyItem[] }> = [];
  const call: ReplyModel = async ({ user }) => {
    const input = JSON.parse(user) as { message: string; items: ReplyItem[] };
    seen.push(input);
    return answer(input.items, input.message);
  };
  return { seen, call };
}

function controls(sent: unknown[]): NoticeActionControls {
  return {
    goal: async () => null,
    sessionState: () => "idle",
    send: async (sessionId, runtime, input) => void sent.push({ sessionId, runtime, ...input }),
    deleteGoal: async () => true,
    resumeGoal: async () => true,
    revealPath: () => {},
    task: () => undefined,
    controlTask: async () => ({ ok: true }),
    lastUserMessage: async () => undefined,
    workspace: async () => undefined,
    openPath: async () => {},
    openExternal: async () => {},
    locateSession: () => {},
  };
}

/** PetImDecisions as main wires it, with the reply model chain and the item executor. */
function relay(h: Harness, models: ReplyModel[], sent: unknown[] = []) {
  const executor = createNoticeActionExecutor({
    router: h.wiring.router,
    controls: controls(sent),
    now: () => env.clock,
  });
  const budgets: boolean[] = [];
  const d = decisionRelay(h, {
    interpret: (message, items, { bound }) => {
      budgets.push(bound);
      return interpretReply({ message, items, models: bound ? models.slice(0, 1) : models });
    },
    actions: {
      items: (channel) => h.wiring.router.openActionItems(channel),
      execute: (request) => executor.execute(request),
    },
  });
  return { ...d, budgets };
}

async function limitStop(h: Harness, sessionId = SID, runId = "run-1"): Promise<void> {
  env.clock += 1_000;
  const before = h.wiring.router.openActionItems("wechat").length;
  for (const event of [
    { type: "session_started", runId, clientMessageId: `cm-${runId}` },
    { type: "tool_use_start", toolCall: { id: "t1", toolName: "Edit", args: {} } },
    { type: "turn_complete", reason: "completed", runId, completionKind: "limit_stop" },
  ])
    h.observeSessionEvent(sessionId, event);
  await settle(() => h.wiring.router.openActionItems("wechat").length > before);
  await h.idle();
}

const resolve = (item: number, action: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ kind: "resolve", item, action, explicit: true, ...extra });

describe("owner replies read by the model", () => {
  test("a plain reply continues a stopped Session; the model only sees this chat's items", async () => {
    current = harness();
    await current.handler(SID, upsertArgs({ channel: "wechat", events: ["blocked"] }));
    const sent: unknown[] = [];
    const m = model(() => resolve(1, "continue"));
    const d = relay(current, [m.call], sent);
    // Nothing open yet: no model is asked.
    expect(await d.relay.reply({ message: "接着干吧", origin: OWNER_DM })).toBeUndefined();
    expect(m.seen).toEqual([]);
    await limitStop(current);
    // Another chat has nothing open: no model, nothing done.
    expect(
      await d.relay.reply({ message: "接着干吧", origin: { ...OWNER_DM, target: "other" } }),
    ).toBeUndefined();
    expect(m.seen).toEqual([]);
    expect(await d.relay.reply({ message: "接着干吧", origin: OWNER_DM })).toBe("已让会话接着做。");
    expect(m.seen[0]!.items).toEqual([
      expect.objectContaining({
        ordinal: 1,
        kind: "limit",
        actions: ["continue", "stop", "handoff"],
      }),
    ]);
    expect(sent).toEqual([
      expect.objectContaining({
        sessionId: SID,
        text: "请从上次停下的地方继续。",
        displayText: "继续",
      }),
    ]);
  });

  test("unrelated and unreadable go on to Mimi when only notice items are open; ambiguous asks back", async () => {
    current = harness();
    await current.handler(SID, upsertArgs({ channel: "wechat", events: ["blocked"] }));
    let reply = '{"kind":"unrelated"}';
    const sent: unknown[] = [];
    const d = relay(current, [async () => reply], sent);
    await limitStop(current);
    expect(await d.relay.reply({ message: "今天天气如何", origin: OWNER_DM })).toBeUndefined();
    reply = '{"kind":"ambiguous","question":"是要继续，还是停下？"}';
    expect(await d.relay.reply({ message: "嗯", origin: OWNER_DM })).toBe("是要继续，还是停下？");
    // An item that was not offered is rejected, like a model that is down: nothing
    // waits on an answer, so Mimi gets the message.
    reply = resolve(4, "continue");
    expect(await d.relay.reply({ message: "继续", origin: OWNER_DM })).toBeUndefined();
    expect(sent).toEqual([]);
    expect(current.wiring.router.openActionItems("wechat")).toHaveLength(1);
  });

  test("a new run of the Session closes its stopped item", async () => {
    current = harness();
    await current.handler(SID, upsertArgs({ channel: "wechat", events: ["blocked"] }));
    await limitStop(current);
    current.observeSessionEvent(SID, { type: "session_started", runId: "run-2" });
    await settle(() => current!.wiring.router.openActionItems("wechat").length === 0);
    expect(current.wiring.router.openActionItems("wechat")).toEqual([]);
  });

  test("two open items are numbered ①②, in the text and for the model", async () => {
    current = harness();
    current.sessions.push(session("s-two"));
    for (const id of [SID, "s-two"])
      await current.handler(
        id,
        upsertArgs({ sessionId: id, channel: "wechat", events: ["blocked"] }),
      );
    const m = model(() => resolve(2, "stop"));
    const d = relay(current, [m.call]);
    await limitStop(current, SID);
    await limitStop(current, "s-two");
    expect(current.ownerSends.map((send) => send.text.slice(0, 2))).toEqual(["「修", "② "]);
    expect(await d.relay.reply({ message: "第二个停了吧", origin: OWNER_DM })).toBe(
      "它已经停了，不会自己再继续。",
    );
    expect(m.seen[0]!.items.map((item) => item.ordinal)).toEqual([1, 2]);
    expect(current.wiring.router.openActionItems("wechat")).toHaveLength(1);
  });

  test("the owner's words reach the Session verbatim, or not at all", async () => {
    current = harness();
    await current.handler(SID, upsertArgs({ channel: "wechat", events: ["blocked"] }));
    const sent: Array<{ text: string }> = [];
    let reply = resolve(1, "continue");
    const d = relay(current, [async () => reply], sent);
    await limitStop(current);
    // A paraphrase is not the owner's words: rejected (and with only notice items, Mimi takes it).
    reply = resolve(1, "handoff", { answer: "请继续执行" });
    expect(await d.relay.reply({ message: "交给你了", origin: OWNER_DM })).toBeUndefined();
    expect(sent).toEqual([]);
  });

  test("a handoff from a private chat reaches Mimi with the owner's words", async () => {
    current = harness();
    await current.handler(SID, upsertArgs({ channel: "wechat", events: ["blocked"] }));
    const d = relay(current, [async () => resolve(1, "handoff")]);
    await limitStop(current);
    const handoff = (await d.relay.reply({ message: "交给 Mimi 吧", origin: OWNER_DM })) as {
      handoff: string;
      dispatched(): Promise<void>;
    };
    expect(handoff.handoff).toContain('"ownerSaid":"交给 Mimi 吧"');
    await handoff.dispatched();
    expect(current.wiring.router.openActionItems("wechat")).toEqual([]);
    expect(d.budgets).toEqual([false]);
  });

  test("an approval needs a plain yes; a high-risk one a second yes to its exact command", async () => {
    current = harness();
    await current.handler(SID, upsertArgs({ events: ["blocked"] }));
    let answer = '{"kind":"nonsense"}';
    const m = model(() => answer);
    const d = relay(current, [m.call]);
    d.raise("req-1", env.clock, "worker", {
      toolName: "Bash",
      description: "Delete the build",
      args: { command: "rm -rf build" },
      riskLevel: "high",
    });
    await settle();
    await d.poll(() => current!.ownerSends.length > 0);
    await settle(() => current!.wiring.router.decisionRecord(d.code()!)?.prompt.phase === "im");
    // A decision waits on the answer: no model, no guess.
    expect(await d.relay.reply({ message: "嗯", origin: OWNER_DM })).toBe(
      "现在没法理解这条回复，请在桌面上处理。",
    );
    answer = resolve(1, "approve");
    // Even a plain yes first gets the exact command repeated back.
    const asked = await d.relay.reply({ message: "可以", origin: OWNER_DM });
    expect(asked).toContain("Bash `rm -rf build`");
    expect(d.approvals).toEqual([]);
    expect(await d.relay.reply({ message: "确定，执行吧", origin: OWNER_DM })).toContain(
      "已允许这一次",
    );
    expect(m.seen.at(-1)!.items[0]).toMatchObject({ kind: "approval", awaitingConfirmation: true });
    // Once only: an approval never carries a session or project scope.
    expect(d.approvals).toEqual([{ approved: true }]);
  });

  test("an ordinary approval with a vague yes is asked back first", async () => {
    current = harness();
    await current.handler(SID, upsertArgs({ events: ["blocked"] }));
    let explicit = false;
    const d = relay(current, [
      async () => JSON.stringify({ kind: "resolve", item: 1, action: "approve", explicit }),
    ]);
    d.raise();
    await settle();
    await d.poll(() => current!.ownerSends.length > 0);
    await settle(() => current!.wiring.router.decisionRecord(d.code()!)?.prompt.phase === "im");
    expect(await d.relay.reply({ message: "嗯…", origin: OWNER_DM })).toContain("明确回我一声");
    explicit = true;
    expect(await d.relay.reply({ message: "允许", origin: OWNER_DM })).toContain("已允许这一次");
    expect(d.approvals).toEqual([{ approved: true }]);
  });
});

describe("the gateway's bound-Session probe", () => {
  test("only a bound chat reads replies there; others go on to the pet chat", async () => {
    const replied: string[] = [];
    const routed: string[] = [];
    let bound = false;
    const handle = sessionRouteHandler({
      bridge: () => ({
        isBound: async () => bound,
        routeInbound: async (inbound) => {
          routed.push(inbound.text);
          return { kind: "not-bound" };
        },
      }),
      replyToSession: async (inbound) => {
        replied.push(inbound.text);
        return { kind: "status", text: "done" };
      },
    });
    const inbound = {
      channel: "wechat",
      target: "dm",
      senderId: "me",
      text: "交给 Mimi 吧",
      isDirectMessage: true,
    };
    // Not bound: never interpreted here (the pet chat reads it once, with handoff).
    expect(await handle(inbound)).toEqual({ kind: "not-bound" });
    expect(replied).toEqual([]);
    bound = true;
    expect(await handle(inbound)).toEqual({ kind: "status", text: "done" });
    expect(replied).toEqual(["交给 Mimi 吧"]);
    expect(routed).toEqual(["交给 Mimi 吧"]);
    // The bridge's own commands never reach a model, even with items open.
    for (const text of ["/mimi", " /Session ", "退出 session"]) await handle({ ...inbound, text });
    expect(replied).toEqual(["交给 Mimi 吧"]);
    expect(routed).toEqual(["交给 Mimi 吧", "/mimi", " /Session ", "退出 session"]);
  });

  test("a bound chat reads a reply with one model within the route budget", async () => {
    current = harness();
    await current.handler(SID, upsertArgs({ channel: "wechat", events: ["blocked"] }));
    const calls: string[] = [];
    const d = relay(current, [
      async () => {
        calls.push("aux");
        throw new Error("down");
      },
      async () => {
        calls.push("main");
        return resolve(1, "continue");
      },
    ]);
    await limitStop(current);
    const answered = await d.relay.replyToSession({
      ...OWNER_DM,
      text: "继续",
    } as never);
    expect(d.budgets).toEqual([true]);
    expect(calls).toEqual(["aux"]);
    expect(answered).toBeUndefined();
    expect(BOUND_TIMEOUT_MS).toBeLessThan(20_000 / 2);
  });
});
