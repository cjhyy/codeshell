import { describe, expect, test } from "bun:test";
import { ChatGateway } from "./chat-gateway.js";
import type { ChannelAdapter, OutgoingMessage } from "./channel.js";

describe("ChatGateway standalone runtime", () => {
  test("runs generic middleware and replies through the source adapter", async () => {
    const adapter = fakeAdapter("custom");
    const gateway = new ChatGateway({ adapters: [adapter] });
    const visited: string[] = [];
    gateway.use(async (_context, next) => {
      visited.push("before");
      await next();
      visited.push("after");
    });
    gateway.use(async ({ message, reply }) => {
      visited.push(message.text);
      await reply({ text: `echo: ${message.text}` });
    });

    await gateway.dispatch(adapter, {
      channel: "custom",
      target: "room-1",
      senderId: "user-1",
      text: "hello",
    });

    expect(visited).toEqual(["before", "hello", "after"]);
    expect(adapter.replies).toEqual([{ target: "room-1", message: { text: "echo: hello" } }]);
  });

  test("supports multiple accounts for the same platform", async () => {
    const first = fakeAdapter("telegram");
    const second = fakeAdapter("telegram");
    const gateway = new ChatGateway({ adapters: [first, second] });
    gateway.use(async ({ reply }) => reply({ text: "ok" }));

    await gateway.dispatch(second, {
      channel: "telegram",
      target: "room-2",
      senderId: "user-2",
      text: "hello",
    });

    expect(first.replies).toEqual([]);
    expect(second.replies).toEqual([{ target: "room-2", message: { text: "ok" } }]);
  });
});

function fakeAdapter(channel: string): ChannelAdapter & {
  replies: Array<{ target: string; message: OutgoingMessage }>;
} {
  const replies: Array<{ target: string; message: OutgoingMessage }> = [];
  return {
    channel,
    replies,
    run: async () => undefined,
    send: async (target, message) => void replies.push({ target, message }),
  };
}
