import { afterEach, beforeEach, describe, expect, test } from "bun:test";
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
  settle,
  upsertArgs,
  type Harness,
} from "./test-utils/notice-wiring-harness.js";

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
  return decisionRelay(h, {
    interpret: (message, items) => interpretReply({ message, items, models }),
    actions: {
      items: (channel) => h.wiring.router.openActionItems(channel),
      execute: (request) => executor.execute(request),
    },
  });
}

async function limitStop(h: Harness, runId = "run-1"): Promise<void> {
  env.clock += 1_000;
  for (const event of [
    { type: "session_started", runId, clientMessageId: `cm-${runId}` },
    { type: "tool_use_start", toolCall: { id: "t1", toolName: "Edit", args: {} } },
    { type: "turn_complete", reason: "completed", runId, completionKind: "limit_stop" },
  ])
    h.observeSessionEvent(SID, event);
  await settle(() => h.wiring.router.openActionItems("wechat").length > 0);
  await h.idle();
}

describe("owner replies read by the model", () => {
  test("a plain reply continues a stopped Session; the model only sees this chat's items", async () => {
    current = harness();
    await current.handler(SID, upsertArgs({ channel: "wechat", events: ["blocked"] }));
    const sent: unknown[] = [];
    const m = model(() => '{"kind":"resolve","item":1,"action":"continue","explicit":true}');
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

  test("unrelated goes on to Mimi; ambiguous asks back; no working model never guesses", async () => {
    current = harness();
    await current.handler(SID, upsertArgs({ channel: "wechat", events: ["blocked"] }));
    let reply = '{"kind":"unrelated"}';
    const sent: unknown[] = [];
    const d = relay(current, [async () => reply], sent);
    await limitStop(current);
    expect(await d.relay.reply({ message: "今天天气如何", origin: OWNER_DM })).toBeUndefined();
    reply = '{"kind":"ambiguous","question":"是要继续，还是停下？"}';
    expect(await d.relay.reply({ message: "嗯", origin: OWNER_DM })).toBe("是要继续，还是停下？");
    // An item that was not offered is rejected, like a model that is down.
    reply = '{"kind":"resolve","item":4,"action":"continue","explicit":true}';
    expect(await d.relay.reply({ message: "继续", origin: OWNER_DM })).toBe(
      "现在没法理解这条回复，请在桌面上处理。",
    );
    expect(sent).toEqual([]);
    expect(current.wiring.router.openActionItems("wechat")).toHaveLength(1);
  });

  test("two open items are numbered ①②, in the text and for the model", async () => {
    current = harness();
    await current.handler(SID, upsertArgs({ channel: "wechat", events: ["blocked"] }));
    const m = model(() => '{"kind":"resolve","item":2,"action":"stop","explicit":true}');
    const d = relay(current, [m.call]);
    await limitStop(current, "run-1");
    await limitStop(current, "run-2");
    expect(current.ownerSends.map((send) => send.text.slice(0, 2))).toEqual(["「修", "② "]);
    expect(await d.relay.reply({ message: "第二个停了吧", origin: OWNER_DM })).toBe(
      "它已经停了，不会自己再继续。",
    );
    expect(m.seen[0]!.items.map((item) => item.ordinal)).toEqual([1, 2]);
    expect(current.wiring.router.openActionItems("wechat")).toHaveLength(1);
  });

  test("a high-risk approval needs a plain yes; a vague one is asked back and stays open", async () => {
    current = harness();
    await current.handler(SID, upsertArgs({ events: ["blocked"] }));
    let explicit = false;
    const m = model((items) =>
      JSON.stringify({ kind: "resolve", item: items[0]!.ordinal, action: "approve", explicit }),
    );
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
    expect(await d.relay.reply({ message: "嗯", origin: OWNER_DM })).toContain(
      "确定只允许这一次吗",
    );
    expect(d.approvals).toEqual([]);
    explicit = true;
    expect(await d.relay.reply({ message: "确定，执行吧", origin: OWNER_DM })).toContain(
      "已允许这一次",
    );
    expect(m.seen[1]!.items[0]).toMatchObject({ kind: "approval", awaitingConfirmation: true });
    // Once only: an approval never carries a session or project scope.
    expect(d.approvals).toEqual([{ approved: true }]);
  });
});
