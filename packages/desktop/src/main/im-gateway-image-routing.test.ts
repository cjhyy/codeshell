import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBoundSessionChat } from "../../../chat/src/bound-session-chat.js";
import { createMimiPetChat } from "../../../chat/src/gateway.js";
import { DesktopControlClient } from "../../../chat/src/desktop-control-client.js";
import { DeliveryQueue } from "../../../chat/src/delivery-queue.js";
import { BUILTIN_CHANNEL_CAPABILITIES, type ChannelAdapter } from "../../../chat/src/channel.js";
import { GatewayControlServer, type PetChatControlRequest } from "./im-gateway-control-server.js";

describe("IM attachment-only session routing", () => {
  test("passes two image-only inbox entries through the real routing HTTP boundary into Mimi", async () => {
    const root = await mkdtemp(join(tmpdir(), "im-image-routing-"));
    const descriptorPath = join(root, "control.json");
    const inboxPath = join(root, "inbox.json");
    const seen: PetChatControlRequest[] = [];
    const errors: unknown[] = [];
    const routeTexts: string[] = [];
    const server = new GatewayControlServer({
      descriptorPath,
      open: async () => {
        throw new Error("unexpected open");
      },
      close: async () => undefined,
      status: () => ({
        running: false,
        tunnelRunning: false,
        tunnelConnected: false,
        passcodeSet: true,
        onlineDeviceCount: 0,
      }),
      pairingUrl: () => {
        throw new Error("unexpected pairing");
      },
      routeSession: async (input) => {
        routeTexts.push(input.text);
        return { kind: "not-bound" };
      },
      petChat: async (input) => {
        seen.push(input);
        return { text: "received", petSessionId: "pet-test" };
      },
    });
    const desktop = new DesktopControlClient({
      descriptorPath,
      autoLaunch: false,
      args: [],
      startupTimeoutMs: 1_000,
    });
    const route = createBoundSessionChat({ desktop });
    const mimi = createMimiPetChat({ desktop });
    const adapter: ChannelAdapter = {
      channel: "wechat",
      capabilities: BUILTIN_CHANNEL_CAPABILITIES.wechat,
      run: async () => undefined,
      send: async () => undefined,
    };
    const replies: string[] = [];
    const queue = new DeliveryQueue(
      {
        path: inboxPath,
        maxPending: 10,
        maxConcurrent: 2,
        maxPerTarget: 2,
        retryBaseMs: 5,
        retryMaxMs: 5,
        completedTtlMs: 60_000,
      },
      async (_adapterId, message) => {
        const context = {
          message,
          adapter,
          reply: async (reply: { text: string }) => void replies.push(reply.text),
        };
        await route(context, () => mimi(context, async () => undefined));
      },
      (error) => void errors.push(error),
    );
    try {
      const descriptor = await server.start();
      await queue.start();
      const images = [Buffer.from([0xff, 0xd8, 0xff, 1]), Buffer.from([0xff, 0xd8, 0xff, 2])];
      for (const [index, bytes] of images.entries()) {
        await queue.enqueue("wechat", {
          channel: "wechat",
          target: "owner",
          senderId: "owner",
          isDirectMessage: true,
          messageId: `image-${index}`,
          text: "",
          attachments: [{ id: `image-${index}`, kind: "image", load: async () => bytes }],
        });
      }
      const deadline = Date.now() + 2_000;
      while (queue.status().pending && errors.length === 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(errors).toEqual([]);
      expect(queue.status().pending).toBe(0);
      expect(routeTexts).toEqual(["", ""]);
      expect(seen).toHaveLength(2);
      expect(seen.map((input) => input.attachments?.[0]?.dataBase64).sort()).toEqual(
        images.map((bytes) => bytes.toString("base64")).sort(),
      );
      expect(seen.every((input) => input.message === "")).toBe(true);
      expect(replies).toEqual(["received", "received"]);

      // Keep malformed payloads rejected even though legitimate empty text is
      // permitted for the route probe. Routing does not carry attachment bytes.
      for (const text of [undefined, null, 42, {}, "x".repeat(32_001)]) {
        const response = await fetch(`${descriptor.baseUrl}/v1/session/route`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${descriptor.token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            channel: "wechat",
            target: "owner",
            senderId: "owner",
            isDirectMessage: true,
            text,
          }),
        });
        expect(response.status).toBe(400);
      }
      expect(routeTexts).toHaveLength(2);
      // Wait for the final atomic inbox write, which follows the in-memory
      // terminal transition; it must not leave either image retrying on disk.
      while (Date.now() < deadline) {
        if (JSON.parse(await readFile(inboxPath, "utf8")).pending.length === 0) break;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(JSON.parse(await readFile(inboxPath, "utf8")).pending).toEqual([]);
    } finally {
      queue.stop();
      await server.stop();
      await rm(root, { recursive: true, force: true });
    }
  });
});
