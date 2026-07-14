import { describe, expect, test } from "bun:test";
import type { ChannelAdapter } from "./channel.js";
import { createDesktopNotificationHandler } from "./notification-relay.js";

describe("createDesktopNotificationHandler", () => {
  test("retries only failed targets for the same event", async () => {
    const sends: string[] = [];
    let failOnce = true;
    const adapter: ChannelAdapter = {
      channel: "telegram",
      run: async () => undefined,
      send: async (target) => {
        sends.push(target);
        if (target === "two" && failOnce) {
          failOnce = false;
          throw new Error("temporary failure");
        }
      },
    };
    const handle = createDesktopNotificationHandler(
      [adapter],
      [
        { channel: "telegram", target: "one" },
        { channel: "telegram", target: "two" },
      ],
    );
    const event = { id: 7, createdAt: 1, type: "tunnel.connected" as const, text: "ready" };

    await expect(handle(event, { streamId: "a".repeat(32) })).rejects.toThrow(
      "notification failed",
    );
    await handle(event, { streamId: "a".repeat(32) });
    expect(sends).toEqual(["one", "two", "two"]);

    await handle({ ...event, id: 8 }, { streamId: "a".repeat(32) });
    expect(sends).toEqual(["one", "two", "two", "one", "two"]);
  });
});
