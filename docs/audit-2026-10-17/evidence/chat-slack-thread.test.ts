import { expect, test } from "bun:test";
import { SlackAdapter } from "../../../packages/chat/src/slack.ts";
import { ChatGateway } from "../../../packages/chat/src/chat-gateway.ts";
import type { ChannelMessage } from "../../../packages/chat/src/channel.ts";

test("observation: normal Slack thread messages lose their thread id and replies target the top level", async () => {
  const adapter = new SlackAdapter({ botToken: "local-bot", appToken: "local-app" });
  const socket = (adapter as any).socket;
  const callbacks = new Map<string, (...args: any[]) => Promise<void>>();
  socket.on = (name: string, callback: any) => callbacks.set(name, callback);
  socket.off = () => undefined;
  socket.start = async () => undefined;
  socket.disconnect = async () => undefined;
  const posted: any[] = [];
  (adapter as any).web.chat.postMessage = async (payload: unknown) => {
    posted.push(payload);
    return { ok: true };
  };
  const seen: ChannelMessage[] = [];
  const gateway = new ChatGateway({ adapters: [adapter] }).use(async ({ message, reply }) => {
    seen.push(message);
    await reply({ text: `Reply to ${message.text}` });
  });
  const abort = new AbortController();
  const running = adapter.run((message) => gateway.dispatch(adapter, message), abort.signal);
  await Promise.resolve();
  try {
    for (const [index, thread_ts] of ["1700000000.000001", "1700000001.000001"].entries()) {
      await callbacks.get("events_api")!({
        event: { type: "message", channel: "C-local", user: "U-local", channel_type: "channel", text: `question ${index}`, ts: `1700000010.00000${index}`, thread_ts },
        ack: async () => undefined,
      });
    }
    expect(seen).toHaveLength(2);
    expect(seen.every((message) => message.threadId === undefined)).toBe(true);
    expect(posted).toHaveLength(2);
    expect(posted.every((payload) => payload.channel === "C-local")).toBe(true);
    expect(posted.every((payload) => payload.thread_ts === undefined)).toBe(true);
    console.log(JSON.stringify({ case: "slack-thread-routing", incomingThreads: ["1700000000.000001", "1700000001.000001"], projectedThreadIds: seen.map((message) => message.threadId ?? null), fakePostPayloads: posted }));
  } finally {
    abort.abort();
    await running;
  }
});
