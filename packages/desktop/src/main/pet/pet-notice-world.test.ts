import { describe, expect, test } from "bun:test";
import type { PetDispatchCommand } from "./pet-dispatch-service.js";
import type { MimiTurnOrigin, PetRecentProactiveNotice } from "./pet-mimi-notice-reads.js";
import { petNoticeWorld } from "./pet-notice-world.js";

type Chat = Extract<PetDispatchCommand, { type: "chat" }>;

const capabilities = {
  inbound: { text: true as const, attachments: [] },
  outbound: { text: true as const, button: "link" as const, attachments: [] },
};

function recorder(notices: PetRecentProactiveNotice[]) {
  const origins: MimiTurnOrigin[] = [];
  return {
    origins,
    source: async (origin: MimiTurnOrigin) => {
      origins.push(origin);
      return notices;
    },
  };
}

const long = (count: number): PetRecentProactiveNotice[] =>
  Array.from({ length: count }, (_, index) => ({
    kind: "heartbeat",
    sentAt: `2026-11-12T0${index}:00:00+08:00`,
    text: "长".repeat(2_000),
    refs: Array.from({ length: 20 }, () => ({
      type: "done",
      status: "【完成】",
      title: "题".repeat(300),
    })),
  }));

describe("petNoticeWorld", () => {
  test("bounds recentProactive: three notices, 600 characters, eight short refs", async () => {
    const { source } = recorder(long(5));
    const world = (await petNoticeWorld({ type: "chat", message: "hi" }, source)) as {
      recentProactive: {
        about: string;
        notices: Array<{ text: string; refs: Array<{ title: string }> }>;
      };
    };
    expect(world.recentProactive.notices).toHaveLength(3);
    for (const notice of world.recentProactive.notices) {
      expect(notice.text.length).toBe(600);
      expect(notice.refs).toHaveLength(8);
      expect(notice.refs.every((ref) => ref.title.length === 80)).toBe(true);
    }
    expect(JSON.stringify(world).length).toBeLessThan(8_000);
  });

  test("asks for the IM conversation the turn answers; wake turns and unaddressed sources get none", async () => {
    const { origins, source } = recorder(long(1));
    const im: Chat = {
      type: "chat",
      message: "hi",
      source: {
        kind: "im-gateway",
        channel: "wechat",
        target: "dm",
        isDirectMessage: true,
        capabilities,
      },
    };
    await petNoticeWorld(im, source);
    expect(
      await petNoticeWorld(
        { ...im, source: { kind: "im-gateway", channel: "wechat", capabilities } },
        source,
      ),
    ).toEqual({});
    expect(
      await petNoticeWorld(
        {
          type: "chat",
          message: "wake",
          hostWake: {
            id: "rule-1",
            revision: 1,
            occurrence: 1,
            title: "t",
            text: "t",
            intent: "remind",
          },
        },
        source,
      ),
    ).toEqual({});
    expect(origins).toEqual([
      { kind: "im", channel: "wechat", target: "dm", isDirectMessage: true },
    ]);
  });

  test("a failing source leaves the turn without it; pending notices are taken once", async () => {
    let taken = 0;
    const world = await petNoticeWorld(
      {
        type: "chat",
        message: "hi",
        pendingNotices: {
          take: async () => {
            taken += 1;
            return [{ kind: "session.done", body: "做完了" }];
          },
          started: () => undefined,
        },
      },
      async () => {
        throw new Error("ledger unreadable");
      },
    );
    expect(taken).toBe(1);
    expect(world).toEqual({ pendingNotices: [{ kind: "session.done", body: "做完了" }] });
  });
});
