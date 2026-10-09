import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GatewayControlServer } from "./im-gateway-control-server.js";
import { DesktopControlClient } from "../../../chat/src/desktop-control-client.js";
import type { DesktopGatewayConfig } from "../../../chat/src/config.js";
import { createBoundSessionChat } from "../../../chat/src/bound-session-chat.js";
import { createMimiPetChat } from "../../../chat/src/gateway.js";
import { DeliveryQueue } from "../../../chat/src/delivery-queue.js";
import { BUILTIN_CHANNEL_CAPABILITIES, type ChannelMessage } from "../../../chat/src/channel.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("desktop control protocol integration", () => {
  test("replays two retained WeChat messages once after automatic descriptor recovery", async () => {
    const root = mkdtempSync(join(tmpdir(), "codeshell-gateway-recovery-"));
    roots.push(root);
    const descriptorPath = join(root, "desktop-control.json");
    const inboxPath = join(root, "inbox.json");
    const dispatched: string[] = [];
    const replies: string[] = [];
    const errors: unknown[] = [];
    const server = new GatewayControlServer({
      descriptorPath,
      descriptorHealthCheckIntervalMs: 500,
      open: async () => {
        throw new Error("unexpected open");
      },
      close: async () => {},
      pairingUrl: () => {
        throw new Error("unexpected pairing");
      },
      status: () => ({
        running: false,
        tunnelRunning: false,
        tunnelConnected: false,
        passcodeSet: true,
        onlineDeviceCount: 0,
      }),
      petChat: async (input) => {
        dispatched.push(input.origin!.messageId!);
        return { text: `收到 ${input.origin!.messageId}`, petSessionId: "pet-recovery" };
      },
      routeSession: async () => ({ kind: "not-bound" }),
    });
    const client = new DesktopControlClient({
      descriptorPath,
      autoLaunch: false,
      args: [],
      startupTimeoutMs: 1_000,
    });
    const mimi = createMimiPetChat({ desktop: client });
    const boundSession = createBoundSessionChat({ desktop: client });
    const adapter = {
      channel: "wechat",
      capabilities: BUILTIN_CHANNEL_CAPABILITIES.wechat,
      run: async () => {},
      send: async () => {},
    };
    const queue = new DeliveryQueue(
      {
        path: inboxPath,
        maxPending: 10,
        maxConcurrent: 1,
        maxPerTarget: 1,
        retryBaseMs: 20,
        retryMaxMs: 20,
        completedTtlMs: 60_000,
      },
      async (_adapterId, message) => {
        const context = {
          message,
          adapter,
          reply: async (reply: { text: string }) => {
            replies.push(reply.text);
          },
        };
        await boundSession(context, () => mimi(context, async () => {}));
      },
      (error) => {
        errors.push(error);
      },
    );
    const messages: ChannelMessage[] = ["first", "second"].map((messageId) => ({
      channel: "wechat",
      target: "owner",
      senderId: "owner",
      isDirectMessage: true,
      messageId,
      text: "香港找工作用什么软件",
    }));
    const until = async (predicate: () => boolean) => {
      const deadline = Date.now() + 5_000;
      while (!predicate()) {
        if (Date.now() > deadline) throw new Error("WeChat recovery did not settle");
        await new Promise((resolveWait) => setTimeout(resolveWait, 5));
      }
    };
    try {
      const descriptor = await server.start();
      rmSync(descriptorPath);
      await queue.start();
      for (const message of messages) await queue.enqueue("wechat", message);
      await until(() => errors.length > 0);
      expect(dispatched).toHaveLength(0);
      expect(JSON.parse(readFileSync(inboxPath, "utf8")).pending).toHaveLength(2);
      await until(() => queue.status().pending === 0);
      expect(JSON.parse(readFileSync(descriptorPath, "utf8"))).toEqual(descriptor);
      expect([...dispatched].sort()).toEqual(["first", "second"]);
      expect([...replies].sort()).toEqual(["收到 first", "收到 second"]);
      for (const message of messages)
        expect(await queue.enqueue("wechat", message)).toBe("duplicate");
      expect(dispatched).toHaveLength(2);
      expect(JSON.parse(readFileSync(inboxPath, "utf8")).pending).toHaveLength(0);
    } finally {
      queue.stop();
      await server.stop();
    }
  });

  test("the standalone client talks to the real Electron-main loopback server", async () => {
    const root = mkdtempSync(join(tmpdir(), "codeshell-gateway-integration-"));
    roots.push(root);
    const descriptorPath = join(root, "desktop-control.json");
    let closes = 0;
    const server = new GatewayControlServer({
      descriptorPath,
      open: async () => ({
        url: "https://integration.trycloudflare.com",
        pairingUrl: "https://integration.trycloudflare.com/mobile?pairing=one-time",
        expiresAt: 1234,
        mode: "tunnel",
      }),
      close: async () => {
        closes++;
      },
      status: () => ({
        running: true,
        mode: "tunnel",
        url: "https://integration.trycloudflare.com",
        tunnelRunning: true,
        tunnelConnected: true,
        passcodeSet: true,
        onlineDeviceCount: 2,
      }),
      pairingUrl: () => ({
        pairingUrl: "https://integration.trycloudflare.com/mobile?pairing=fresh",
        expiresAt: 5678,
      }),
    });
    await server.start();

    const config: DesktopGatewayConfig = {
      descriptorPath,
      autoLaunch: false,
      args: [],
      startupTimeoutMs: 1_000,
    };
    const client = new DesktopControlClient(config);
    expect(await client.status()).toMatchObject({ tunnelConnected: true, onlineDeviceCount: 2 });
    expect(await client.open()).toMatchObject({ mode: "tunnel", expiresAt: 1234 });
    const events = client.events(0, 1_000);
    await server.publish({
      type: "tunnel.connected",
      text: "Tunnel ready",
      button: { text: "Open", url: "https://integration.trycloudflare.com" },
      attachments: [
        {
          kind: "image",
          name: "comic.png",
          mimeType: "image/png",
          size: 123,
          path: "/tmp/comic.png",
        },
      ],
    });
    expect(await events).toMatchObject({
      cursor: 1,
      events: [
        {
          id: 1,
          type: "tunnel.connected",
          text: "Tunnel ready",
          attachments: [{ kind: "image", path: "/tmp/comic.png" }],
        },
      ],
    });
    await client.close();
    expect(closes).toBe(1);
    await server.stop();
  });
});
