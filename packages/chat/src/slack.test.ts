import { describe, expect, test } from "bun:test";
import { ChatGateway } from "./chat-gateway.js";
import type { ChannelMessage } from "./channel.js";
import { SlackAdapter } from "./slack.js";
import { DeliveryBackpressureError } from "./delivery-queue.js";

describe("Slack adapter", () => {
  for (const kind of ["event", "command"] as const) {
    for (const error of [
      new DeliveryBackpressureError(1),
      new Error("ENOSPC: inbox persistence failed"),
    ]) {
      test(`${kind} leaves a rejected delivery unacknowledged and accepts its retry: ${error.message}`, async () => {
        const { adapter, emit, emitCommand, stop } = await startSlack();
        let attempts = 0;
        let acknowledgements = 0;
        adapter.onMessage = async () => {
          if (++attempts === 1) throw error;
        };
        const ack = async () => {
          acknowledgements++;
        };
        const deliver = () =>
          kind === "event"
            ? emit({ text: "persist me", client_msg_id: "retry-id" }, ack)
            : emitCommand(
                { command: "/codeshell", text: "persist me", trigger_id: "retry-id" },
                ack,
              );
        try {
          await deliver();
          expect(acknowledgements).toBe(0);
          await deliver();
          expect(attempts).toBe(2);
          expect(acknowledgements).toBe(1);
        } finally {
          await stop();
        }
      });
    }
    test(`${kind} waits for durable admission before acknowledgement`, async () => {
      const { adapter, emit, emitCommand, stop } = await startSlack();
      let release!: () => void;
      const admitted = new Promise<void>((resolve) => {
        release = resolve;
      });
      adapter.onMessage = () => admitted;
      let acknowledged = false;
      const ack = async () => {
        acknowledged = true;
      };
      const delivery =
        kind === "event"
          ? emit({ text: "pending" }, ack)
          : emitCommand({ command: "/codeshell", text: "pending" }, ack);
      try {
        await Promise.resolve();
        expect(acknowledged).toBe(false);
        release();
        await delivery;
        expect(acknowledged).toBe(true);
      } finally {
        release();
        await stop();
      }
    });
  }
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
  (adapter as any).web.conversations.info = async () => ({ channel: { is_im: true } });
  const abort = new AbortController();
  const running = adapter.run((message) => adapter.onMessage!(message), abort.signal);
  await Promise.resolve();
  return {
    adapter,
    posted,
    emit: (event: Record<string, unknown>, ack: () => Promise<void> = async () => undefined) =>
      listeners.get("events_api")!({
        event: { type: "message", channel: "C1", user: "U1", channel_type: "channel", ...event },
        ack,
      }),
    emitCommand: (
      body: Record<string, unknown>,
      ack: () => Promise<void> = async () => undefined,
    ) =>
      listeners.get("slash_commands")!({ body: { channel_id: "C1", user_id: "U1", ...body }, ack }),
    stop: async () => {
      abort.abort();
      await running;
    },
  };
}
