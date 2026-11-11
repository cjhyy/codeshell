import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createNoticeActionExecutor, type NoticeActionControls } from "./pet-notice-actions.js";
import {
  clampDeferUntil,
  DEFER_MAX_MS,
  deferNotice,
  describeLocalTime,
} from "./pet-notice-defer.js";
import type { NoticeRecord } from "./pet-notice-ledger.js";
import { interpretReply, type ReplyItem, type ReplyModel } from "./pet-notice-reply-interpreter.js";
import type { NoticeSubmission } from "./pet-notice-types.js";
import {
  OWNER_DM,
  cleanupNoticeEnv,
  decisionRelay,
  env,
  harness,
  resetNoticeEnv,
  type Harness,
} from "./test-utils/notice-wiring-harness.js";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const UTC = () => 0;

describe("when a put-off notice comes back", () => {
  const now = Date.UTC(2023, 10, 14, 22, 13);

  test("the model's time, clamped to [5 min, 36 h]; no time named: the next 09:00", () => {
    expect(clampDeferUntil(Date.UTC(2023, 10, 15, 9, 0), now, UTC)).toBe(
      Date.UTC(2023, 10, 15, 9, 0),
    );
    expect(clampDeferUntil(now + 100 * HOUR, now, UTC)).toBe(now + DEFER_MAX_MS);
    expect(clampDeferUntil(now - HOUR, now, UTC)).toBe(now + 5 * MINUTE);
    expect(clampDeferUntil(undefined, now, UTC)).toBe(Date.UTC(2023, 10, 15, 9, 0));
    // UTC+8: 22:13 UTC is 06:13 local, so the next 09:00 is the same local day.
    expect(clampDeferUntil(undefined, now, () => 480)).toBe(Date.UTC(2023, 10, 15, 1, 0));
  });

  test("said in the owner's own clock", () => {
    expect(describeLocalTime(Date.UTC(2023, 10, 15, 9, 0), now, UTC)).toBe("明天 09:00 ");
    expect(describeLocalTime(now + HOUR, now, UTC)).toBe("今天 23:13 ");
    expect(describeLocalTime(Date.UTC(2023, 10, 16, 9, 0), now, UTC)).toBe("后天 09:00 ");
    expect(describeLocalTime(Date.UTC(2023, 10, 20, 9, 0), now, UTC)).toBe("11月20日 09:00 ");
  });

  test("at most twice per notice", async () => {
    const record = {
      id: "notice-1",
      kind: "digest",
      deferCount: 2,
      actions: { code: "AAAAAAAAAAAA", family: "notice", expiresAt: now + HOUR },
    } as unknown as NoticeRecord;
    let recorded = 0;
    const result = await deferNotice(
      {
        ledger: {
          byActionCode: () => record,
          record: async () => {
            recorded += 1;
            return record;
          },
        },
        useAction: async () => undefined,
        now: () => now,
        offset: UTC,
        schedule: () => undefined,
        log: () => undefined,
      },
      "AAAAAAAAAAAA",
      now + HOUR,
    );
    expect(result).toEqual({ ok: false, reason: "limit" });
    expect(recorded).toBe(0);
  });
});

let current: Harness | undefined;
beforeEach(resetNoticeEnv);
afterEach(async () => {
  await cleanupNoticeEnv(current);
  current = undefined;
});

const noControls = {} as NoticeActionControls;

/** PetImDecisions over the harness, with the reply model and the item executor (owner at UTC). */
function relay(h: Harness, model: ReplyModel) {
  const executor = createNoticeActionExecutor({
    router: h.wiring.router,
    controls: noControls,
    now: () => env.clock,
    describeTime: (ms) => describeLocalTime(ms, env.clock, UTC),
  });
  return decisionRelay(h, {
    interpret: (message, items) =>
      interpretReply({
        message,
        items,
        models: [model],
        clock: { now: env.clock, timezoneOffsetMin: 0 },
      }),
    actions: {
      items: (channel) => h.wiring.router.openActionItems(channel),
      execute: (request) => executor.execute(request),
    },
  }).relay;
}

function brief(text: string): NoticeSubmission {
  return {
    kind: "brief.evening",
    priority: "P1",
    dedupeKey: `brief:evening:${text}`,
    ruleIds: ["system-brief-evening"],
    facts: { title: "收工小结", summary: text },
    body: text,
    attention: "always",
    channel: "auto",
    target: { kind: "owner" },
    actions: { family: "notice" },
  };
}

describe("现在别说，明早再说", () => {
  test("the model reads the time; the host keeps a copy and sends it once, then once more at most", async () => {
    current = harness();
    const h = current;
    await h.wiring.ready;
    const seen: Array<{ items: ReplyItem[]; now?: string }> = [];
    let answer = "";
    const model: ReplyModel = async ({ user }) => {
      seen.push(JSON.parse(user));
      return answer;
    };
    const d = relay(h, model);
    await h.wiring.submitNotice(brief("今天：登录修好了"));
    await h.idle();
    expect(h.ownerSends.map((send) => send.text)).toEqual(["今天：登录修好了"]);

    answer = JSON.stringify({
      kind: "resolve",
      item: 1,
      action: "defer",
      until: "2023-11-15T09:00:00+00:00",
      explicit: true,
    });
    expect(await d.reply({ message: "现在别说，明早再说", origin: OWNER_DM })).toBe(
      "好，明天 09:00 再说。",
    );
    // The model was shown the item, what it can do, and the owner's clock.
    expect(seen[0]).toMatchObject({
      items: [{ kind: "notice", actions: ["defer"], text: "今天：登录修好了" }],
      now: "2023-11-14T22:13:20+00:00",
    });
    // Said once: the item is used, nothing open any more.
    expect(h.wiring.router.openActionItems("wechat")).toEqual([]);
    const copy = h.wiring.ledger.held()[0]!;
    expect(copy).toMatchObject({
      kind: "brief.evening",
      deferredUntil: Date.UTC(2023, 10, 15, 9, 0),
      deferCount: 1,
      decision: { reason: "deferred" },
    });

    env.clock = Date.UTC(2023, 10, 15, 8, 59);
    await h.wiring.router.flushDigest();
    await h.idle();
    expect(h.ownerSends).toHaveLength(1);
    env.clock = Date.UTC(2023, 10, 15, 9, 0);
    await h.wiring.router.flushDigest();
    await h.idle();
    expect(h.ownerSends.map((send) => send.text)).toEqual(["今天：登录修好了", "今天：登录修好了"]);
    await h.wiring.router.flushDigest();
    await h.idle();
    expect(h.ownerSends).toHaveLength(2);

    // Put off again, too far ahead: clamped to 36 hours.
    answer = JSON.stringify({
      kind: "resolve",
      item: 1,
      action: "defer",
      until: "2023-11-20T09:00:00Z",
      explicit: true,
    });
    expect(await d.reply({ message: "下周再说", origin: OWNER_DM })).toBe(
      `好，${describeLocalTime(env.clock + DEFER_MAX_MS, env.clock, UTC)}再说。`,
    );
    env.clock += DEFER_MAX_MS;
    await h.wiring.router.flushDigest();
    await h.idle();
    expect(h.ownerSends).toHaveLength(3);
    // Twice is the limit: the last copy is no longer an item that can be put off.
    expect(h.wiring.router.openActionItems("wechat")).toEqual([]);
  });

  test("a time is only taken for defer, and only as a full ISO instant", async () => {
    const { parseInterpretation } = await import("./pet-notice-reply-interpreter.js");
    const items: ReplyItem[] = [
      { ordinal: 1, ref: "A", kind: "notice", text: "早报", actions: ["defer"] },
      { ordinal: 2, ref: "B", kind: "open", text: "做完了", actions: ["open"] },
    ];
    const read = (value: Record<string, unknown>) =>
      parseInterpretation(JSON.stringify({ kind: "resolve", explicit: true, ...value }), items);
    expect(read({ item: 1, action: "defer" })).toMatchObject({ action: "defer" });
    expect(read({ item: 1, action: "defer", until: "2023-11-15T09:00:00+08:00" })).toMatchObject({
      until: Date.UTC(2023, 10, 15, 1, 0),
    });
    expect(read({ item: 1, action: "defer", until: "明早" })).toBeUndefined();
    expect(read({ item: 1, action: "defer", until: "2023-11-15" })).toBeUndefined();
    expect(read({ item: 2, action: "open", until: "2023-11-15T09:00:00Z" })).toBeUndefined();
    expect(read({ item: 2, action: "defer" })).toBeUndefined();
  });
});
