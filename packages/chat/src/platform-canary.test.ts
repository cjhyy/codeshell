import { describe, expect, test } from "bun:test";
import type { ChannelAdapter, OutgoingMessage } from "./channel.js";
import { runPlatformCanary } from "./platform-canary.js";

describe("real-platform canary orchestration", () => {
  test("requires an allowlisted inbound challenge and verifies the outbound reply", async () => {
    const telegram = canaryAdapter("telegram", "nonce-1");
    const slack = canaryAdapter("slack", "nonce-1");
    const result = await runPlatformCanary({
      adapters: [telegram, slack],
      allowlists: {
        telegram: { targetIds: ["telegram-room"], userIds: ["owner"] },
        slack: { targetIds: ["slack-room"], userIds: ["owner"] },
      },
      webhook: { port: 0 },
      timeoutMs: 1_000,
      nonce: "nonce-1",
    });
    expect(result.channels).toEqual(["slack", "telegram"]);
    expect(telegram.sent[0]?.message.text).toContain("canary passed");
    expect(slack.sent[0]?.message.text).toContain("canary passed");
  });
});

function canaryAdapter(
  channel: string,
  nonce: string,
): ChannelAdapter & {
  sent: Array<{ target: string; message: OutgoingMessage }>;
} {
  const sent: Array<{ target: string; message: OutgoingMessage }> = [];
  return {
    channel,
    sent,
    run: async (handler, signal) => {
      await handler({
        channel,
        target: `${channel}-room`,
        senderId: "owner",
        messageId: `${channel}-message`,
        text: `/canary ${nonce}`,
      });
      if (!signal.aborted) {
        await new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => resolve(), { once: true }),
        );
      }
    },
    send: async (target, message) => void sent.push({ target, message }),
  };
}
