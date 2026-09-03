import { describe, expect, test } from "bun:test";
import { createBoundSessionChat, type BoundSessionDisposition } from "./bound-session-chat.js";
import type { ChannelMessage, OutgoingMessage } from "./channel.js";
import type { ChatContext } from "./chat-gateway.js";

function message(overrides: Partial<ChannelMessage> = {}): ChannelMessage {
  return {
    channel: "wechat",
    target: "owner-1",
    senderId: "owner-1",
    text: "继续修那个 bug",
    messageId: "m-1",
    ...overrides,
  };
}

async function run(
  disposition: BoundSessionDisposition | (() => Promise<BoundSessionDisposition>),
  overrides: Partial<ChannelMessage> = {},
  isDirectMessage?: (message: ChannelMessage) => boolean,
) {
  const replies: OutgoingMessage[] = [];
  let nextCalled = false;
  const seen: unknown[] = [];
  const middleware = createBoundSessionChat({
    desktop: {
      routeBoundSessionMessage: async (input) => {
        seen.push(input);
        return typeof disposition === "function" ? disposition() : disposition;
      },
    },
    ...(isDirectMessage ? { isDirectMessage } : {}),
  });
  const context = {
    message: message(overrides),
    adapter: {} as ChatContext["adapter"],
    reply: async (outgoing: OutgoingMessage) => {
      replies.push(outgoing);
    },
  } as ChatContext;
  await middleware(context, async () => {
    nextCalled = true;
  });
  return { replies, nextCalled, seen };
}

describe("falling through to Mimi", () => {
  test("an unbound conversation reaches Mimi unchanged", async () => {
    const { nextCalled, replies } = await run({ kind: "not-bound" });
    expect(nextCalled).toBe(true);
    expect(replies).toEqual([]);
  });

  test("an unaddressable message is left to Mimi without consulting the host", async () => {
    // Without target and sender a reply could reach the wrong person.
    const { nextCalled, seen } = await run({ kind: "accepted" }, { senderId: "  " });
    expect(nextCalled).toBe(true);
    expect(seen).toEqual([]);
  });

  test("an empty message is ignored here", async () => {
    const { nextCalled, seen } = await run({ kind: "accepted" }, { text: "   " });
    expect(nextCalled).toBe(true);
    expect(seen).toEqual([]);
  });

  test("a bridge failure falls back to Mimi rather than dropping the message", async () => {
    const { nextCalled } = await run(async () => {
      throw new Error("control plane down");
    });
    expect(nextCalled).toBe(true);
  });
});

describe("routing into the Session", () => {
  test("an accepted message stops the chain and sends nothing yet", async () => {
    // A Session turn can take minutes; the answer comes back via the outbox.
    const { nextCalled, replies } = await run({ kind: "accepted" });
    expect(nextCalled).toBe(false);
    expect(replies).toEqual([]);
  });

  test("an accepted message with a stale notice sends exactly that notice", async () => {
    const { replies, nextCalled } = await run({
      kind: "accepted",
      notice: "这条消息会发送到「修复登录问题」。发送 /mimi 可以退出。",
    });
    expect(nextCalled).toBe(false);
    expect(replies).toHaveLength(1);
    expect(replies[0]!.text).toContain("/mimi");
  });

  test("passes the conversation identity the host needs to resolve a route", async () => {
    const { seen } = await run({ kind: "accepted" });
    expect(seen[0]).toMatchObject({
      channel: "wechat",
      target: "owner-1",
      senderId: "owner-1",
      messageId: "m-1",
      isDirectMessage: true,
    });
  });

  test("reports a group chat so the host can refuse to bind it", async () => {
    const { seen } = await run({ kind: "not-bound" }, {}, () => false);
    expect(seen[0]).toMatchObject({ isDirectMessage: false });
  });
});

describe("control replies", () => {
  test("leaving, status and suspension each answer immediately", async () => {
    for (const kind of ["left", "status", "suspended"] as const) {
      const { replies, nextCalled } = await run({ kind, text: `reply for ${kind}` });
      expect(nextCalled).toBe(false);
      expect(replies).toHaveLength(1);
      expect(replies[0]!.text).toBe(`reply for ${kind}`);
    }
  });
});
