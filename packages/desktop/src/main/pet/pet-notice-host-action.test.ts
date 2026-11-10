import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  NOW,
  SID,
  boundRoute,
  cleanupNoticeEnv,
  harness,
  resetNoticeEnv,
  session,
  upsertArgs,
  type Harness,
} from "./test-utils/notice-wiring-harness.js";

let current: Harness | undefined;

beforeEach(resetNoticeEnv);

afterEach(async () => {
  await cleanupNoticeEnv(current);
  current = undefined;
});

describe("NotifyMe host action", () => {
  test("stores a user rule and reports its effect", async () => {
    current = harness();
    const reply = await current.handler(SID, upsertArgs());
    expect(reply).toMatchObject({
      ok: true,
      status: "ok",
      effect: {
        fires: "这个会话下一次完成实际工作后（你在电脑前时发桌面，不在时发微信）",
        channel: "auto",
        im: { channel: "wechat", label: "微信", ready: "ready" },
        quietHours: "23:00–08:30 只推需要你决定的事",
      },
    });
    const [rule] = current.wiring.ruleStore.activeForSession(SID);
    expect(rule).toMatchObject({
      origin: "user",
      target: { kind: "owner" },
      when: { kind: "session", sessionId: SID, scope: "turn", armedAt: NOW },
    });
    expect((reply as { effect: { ruleId: string } }).effect.ruleId).toBe(rule!.id);
  });

  test("a goal rule on a bound Session targets its IM conversation", async () => {
    current = harness();
    current.routes.push(boundRoute());
    const reply = await current.handler(SID, upsertArgs({ scope: "goal", channel: "lark" }));
    // The bound conversation's channel is the one that will actually be used.
    expect(reply).toMatchObject({
      status: "ok",
      effect: {
        fires: "目标完成或卡住时",
        channel: "lark",
        im: { channel: "wechat", label: "微信", ready: "ready" },
      },
    });
    expect(current.wiring.ruleStore.activeForSession(SID)[0]!.target).toMatchObject({
      kind: "route",
      route: { kind: "im-gateway", channel: "wechat", target: "chat-1", senderId: "owner-1" },
    });
  });

  test("an unbound channel returns the bound channels and saves nothing", async () => {
    current = harness();
    const reply = await current.handler(SID, upsertArgs({ channel: "telegram" }));
    expect(reply).toEqual({
      ok: true,
      status: "unknown_channel",
      channels: [
        { id: "wechat", label: "微信", ready: "ready" },
        { id: "lark", label: "飞书", ready: "unknown" },
      ],
    });
    expect(current.wiring.ruleStore.activeForSession(SID)).toEqual([]);
  });

  test("rejects malformed args, another Session's id and unknown Sessions", async () => {
    current = harness();
    await expect(current.handler(SID, upsertArgs({ events: ["later"] }))).rejects.toThrow(
      "invalid notice rule request",
    );
    await expect(current.handler(SID, { ...upsertArgs(), extra: 1 })).rejects.toThrow(
      "invalid notice rule request",
    );
    await expect(current.handler("s-other", upsertArgs())).rejects.toThrow("for itself");
    await expect(current.handler("s-ghost", upsertArgs({ sessionId: "s-ghost" }))).rejects.toThrow(
      "unknown work Session",
    );
    current.sessions[0] = session(SID, { external: { cli: "codex" } });
    await expect(current.handler(SID, upsertArgs())).rejects.toThrow("unknown work Session");
  });
});
