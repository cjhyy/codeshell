import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { PetNoticeWiringDeps } from "./pet-notice-wiring.js";
import {
  OWNER_DM,
  SID,
  cleanupNoticeEnv,
  env,
  harness,
  longTask,
  resetNoticeEnv,
  settle,
  sourceFile,
  upsertArgs,
  type Harness,
} from "./test-utils/notice-wiring-harness.js";

let current: Harness | undefined;

beforeEach(resetNoticeEnv);

afterEach(async () => {
  await cleanupNoticeEnv(current);
  current = undefined;
});

describe("pending-notice replay", () => {
  test("a queued notice is taken when the inbound turn starts and settled then", async () => {
    current = harness();
    current.channels[1] = { id: "lark", label: "飞书", ready: "unavailable" };
    await current.handler(SID, upsertArgs({ channel: "lark" }));
    await current.wiring.notifyTaskClosed(longTask({ status: "failed", lastError: "编译失败" }));
    expect(current.ownerSends).toEqual([]);
    const origin = { channel: "lark", target: "dm-1", senderId: "owner", isDirectMessage: true };
    expect(await current.wiring.inboundReplay({ ...origin, channel: "wechat" })!.take()).toEqual(
      [],
    );
    expect(
      await current.wiring.inboundReplay({ ...origin, isDirectMessage: false })!.take(),
    ).toEqual([]);
    expect(current.wiring.inboundReplay(undefined)).toBeUndefined();

    // Taken but the turn never started (e.g. it failed first): released.
    const first = current.wiring.inboundReplay(origin)!;
    expect(await first.take()).toEqual([
      { kind: "session.failed", title: "修登录", body: "「修登录」没做完：编译失败" },
    ]);
    const concurrent = current.wiring.inboundReplay(origin)!;
    expect(await concurrent.take()).toEqual([]);
    concurrent.finish();
    first.finish();

    // A message that waited in the queue takes them only when its turn starts.
    const queued = current.wiring.inboundReplay(origin)!;
    const second = current.wiring.inboundReplay(origin)!;
    expect(await second.take()).toHaveLength(1);
    second.started();
    second.finish();
    await settle();
    expect(await queued.take()).toEqual([]);
    queued.finish();
  });

  test("a queued owner notice with media is sent on the next inbound, not put in the turn", async () => {
    current = harness();
    current.channels[1] = { id: "lark", label: "飞书", ready: "unavailable" };
    await current.handler(SID, upsertArgs({ channel: "lark" }));
    const media = {
      attachments: [
        {
          kind: "file" as const,
          name: "r.txt",
          mimeType: "text/plain",
          size: 10,
          path: await sourceFile("r.txt", 10),
        },
      ],
    };
    await current.wiring.notifyTaskClosed(longTask(), { text: "报告好了", media });
    expect(current.ownerSends).toEqual([]);
    current.channels[1] = {
      id: "lark",
      label: "飞书",
      ready: "ready",
      targetId: "lark:owner",
      isDirect: true,
    };
    const replay = current.wiring.inboundReplay({
      channel: "lark",
      target: "dm-1",
      isDirectMessage: true,
    })!;
    expect(await replay.take()).toEqual([]);
    // The send runs in the background so it never delays the inbound turn.
    await current.wiring.router.resendsSettled();
    expect(current.ownerSends).toEqual([
      expect.objectContaining({ targetId: "lark:owner", text: "报告好了", attachments: ["r.txt"] }),
    ]);
  });
});

describe("digest after sleep", () => {
  test("waking, unlocking and the owner's next inbound turn send a due digest", async () => {
    const power = new EventEmitter();
    current = harness({ powerEvents: power as unknown as PetNoticeWiringDeps["powerEvents"] });
    await current.wiring.ready;
    const night = (day: number) => Date.UTC(2026, 10, day, 23, 30, 0);
    const morning = (day: number) => Date.UTC(2026, 10, day + 1, 8, 30, 0);
    const hold = async (day: number, title: string) => {
      env.clock = night(day);
      const decision = await current!.wiring.router.submit({
        kind: "session.done",
        priority: "P1",
        dedupeKey: `done:${title}`,
        sessionId: SID,
        ruleIds: [],
        facts: { title },
        attention: "always",
        channel: "auto",
        target: { kind: "owner" },
      });
      expect(decision).toMatchObject({ outlet: "digest", reason: "quiet-hours" });
      env.clock = morning(day);
    };
    const sent = () => current!.ownerSends.map((send) => send.text);

    await hold(9, "一");
    power.emit("resume");
    await settle(() => sent().length === 1);
    expect(sent()).toEqual(["你不在时：\n- 「一」做完了"]);

    await hold(10, "二");
    power.emit("unlock-screen");
    await settle(() => sent().length === 2);
    expect(sent()[1]).toBe("你不在时：\n- 「二」做完了");

    await hold(11, "三");
    const replay = current.wiring.inboundReplay(OWNER_DM)!;
    await replay.take();
    replay.finish();
    await settle(() => sent().length === 3);
    expect(sent()[2]).toBe("你不在时：\n- 「三」做完了");

    current.wiring.dispose();
    expect(power.listenerCount("resume") + power.listenerCount("unlock-screen")).toBe(0);
  });
});
