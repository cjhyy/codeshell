import { describe, expect, test } from "bun:test";
import { ChatGateway } from "./chat-gateway.js";
import type { ChannelMessage } from "./channel.js";
import { SlackAdapter } from "./slack.js";

describe("Slack adapter", () => {
  test("keeps thread identity so replies stay in the originating thread", async () => {
    const { adapter, emit, posted, stop } = await startSlack();
    const seen: ChannelMessage[] = [];
    const gateway = new ChatGateway({ adapters: [adapter] }).use(async ({ message, reply }) => {
      seen.push(message);
      await reply({ text: `reply to ${message.text}` });
    });
    adapter.onMessage = (message) => gateway.dispatch(adapter, message);
    try {
      await emit({ text: "in thread", ts: "1700000010.000001", thread_ts: "1700000000.000001" });
      await emit({ text: "top level", ts: "1700000020.000001" });
    } finally {
      await stop();
    }
    expect(seen.map(({ threadId }) => threadId)).toEqual(["1700000000.000001", undefined]);
    expect(posted).toEqual([
      { channel: "C1", text: "reply to in thread", thread_ts: "1700000000.000001" },
      { channel: "C1", text: "reply to top level" },
    ]);
  });

  test("publishes thread replies with attachments into the thread", async () => {
    const adapter = new SlackAdapter({ botToken: "xoxb-token", appToken: "xapp-token" });
    let payload: any;
    (adapter as any).web.filesUploadV2 = async (value: unknown) => void (payload = value);
    await adapter.send(
      "C1",
      {
        text: "caption",
        attachments: [
          { kind: "image", name: "a.png", mimeType: "image/png", data: Uint8Array.from([1]) },
        ],
      },
      { threadId: "1700000000.000001" },
    );
    expect(payload).toMatchObject({ channel_id: "C1", thread_ts: "1700000000.000001" });
  });
});

async function startSlack() {
  const adapter = new SlackAdapter({
    botToken: "xoxb-token",
    appToken: "xapp-token",
  }) as SlackAdapter & {
    onMessage?: (message: ChannelMessage) => Promise<void>;
  };
  const socket = (adapter as any).socket;
  const listeners = new Map<string, (payload: unknown) => Promise<void>>();
  socket.on = (name: string, listener: (payload: unknown) => Promise<void>) =>
    listeners.set(name, listener);
  socket.off = () => undefined;
  socket.start = async () => undefined;
  socket.disconnect = async () => undefined;
  const posted: unknown[] = [];
  (adapter as any).web.chat.postMessage = async (payload: unknown) => {
    posted.push(payload);
    return { ok: true };
  };
  const abort = new AbortController();
  const running = adapter.run((message) => adapter.onMessage!(message), abort.signal);
  await Promise.resolve();
  return {
    adapter,
    posted,
    emit: (event: Record<string, unknown>) =>
      listeners.get("events_api")!({
        event: { type: "message", channel: "C1", user: "U1", channel_type: "channel", ...event },
        ack: async () => undefined,
      }),
    stop: async () => {
      abort.abort();
      await running;
    },
  };
}
