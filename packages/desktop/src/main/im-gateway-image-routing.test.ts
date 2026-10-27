import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChannelAdapter } from "../../../chat/src/channel.js";
import type { PetChatControlRequest } from "./im-gateway-control-server.js";
import { installFixtureNetworkGuard } from "../../../../tests/helpers/network-fixture.js";
const guard = installFixtureNetworkGuard();
const { createBoundSessionChat } = await import("../../../chat/src/bound-session-chat.js");
const { createMimiPetChat } = await import("../../../chat/src/gateway.js");
const { DesktopControlClient } = await import("../../../chat/src/desktop-control-client.js");
const { DeliveryQueue } = await import("../../../chat/src/delivery-queue.js");
const { BUILTIN_CHANNEL_CAPABILITIES } = await import("../../../chat/src/channel.js");
const { GatewayControlServer } = await import("./im-gateway-control-server.js");
const { SessionConversationBridge } = await import("./pet/session-conversation-bridge.js");
const { ConversationSessionRouteStore } = await import("./pet/conversation-session-route-store.js");

describe("IM attachment session routing", () => {
  test("delivers unbound images to Mimi and rejects bound attachments across the real HTTP boundary", async () => {
    const root = await mkdtemp(join(tmpdir(), "im-image-routing-"));
    const descriptorPath = join(root, "control.json");
    const inboxPath = join(root, "inbox.json");
    const seen: PetChatControlRequest[] = [];
    const errors: unknown[] = [];
    const routeTexts: string[] = [];
    const routes = new ConversationSessionRouteStore(join(root, "routes.json"));
    const runs: unknown[] = [];
    const bridge = new SessionConversationBridge({
      routes,
      health: { check: async () => ({ ok: true }) },
      describeStatus: async () => "ready",
      runner: {
        isRunning: async () => false,
        run: async (input: unknown) => {
          runs.push(input);
          return { started: true };
        },
      } as any,
    });
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
        return bridge.accept(input);
      },
      petChat: async (input) => {
        seen.push(input);
        return { text: "received", petSessionId: "pet-test" };
      },
    });
    const desktop = new DesktopControlClient(
      { descriptorPath, autoLaunch: false, args: [], startupTimeoutMs: 1_000 },
      { fetch: ((input, init) => fetch(input, { ...init, redirect: "error" })) as typeof fetch },
    );
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
      guard.allowOrigin(descriptor.baseUrl);
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
          redirect: "error",
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

      await routes.upsert({
        routeKey: "im:wechat\u0000owner\u0000owner",
        channel: "wechat",
        target: "owner",
        senderId: "owner",
        sessionId: "bound-session",
        sessionTitle: "Bound",
        mode: "bound",
        origin: "enter",
      });
      let attachmentLoads = 0;
      let fallthrough = 0;
      for (const text of ["", "分析这张图片"]) {
        await route(
          {
            adapter,
            message: {
              channel: "wechat",
              target: "owner",
              senderId: "owner",
              isDirectMessage: true,
              text,
              attachments: [
                {
                  id: "bound-image",
                  kind: "image",
                  load: async () => {
                    attachmentLoads++;
                    return images[0]!;
                  },
                },
              ],
            },
            reply: async (reply) => {
              replies.push(reply.text);
            },
          },
          async () => {
            fallthrough++;
          },
        );
      }
      expect(runs).toEqual([]);
      expect(attachmentLoads).toBe(0);
      expect(fallthrough).toBe(0);
      expect(replies.slice(2).every((text) => text.includes("这条消息未发送"))).toBe(true);
      expect(replies).toHaveLength(4);
      await route(
        {
          adapter,
          message: {
            channel: "wechat",
            target: "owner",
            senderId: "owner",
            isDirectMessage: true,
            text: "文字继续",
            messageId: "text-only",
          },
          reply: async () => {},
        },
        async () => {
          fallthrough++;
        },
      );
      expect(runs).toHaveLength(1);
      expect(runs[0]).toMatchObject({ sessionId: "bound-session", text: "文字继续" });
      const malformed = await fetch(`${descriptor.baseUrl}/v1/session/route`, {
        method: "POST",
        redirect: "error",
        headers: {
          authorization: `Bearer ${descriptor.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          channel: "wechat",
          target: "owner",
          senderId: "owner",
          isDirectMessage: true,
          text: "caption",
          hasAttachments: "false",
        }),
      });
      expect(malformed.status).toBe(400);
    } finally {
      queue.stop();
      await server.stop();
      await rm(root, { recursive: true, force: true });
      guard.restore();
    }
  });
});
