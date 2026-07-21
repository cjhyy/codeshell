import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GatewayControlServer } from "./im-gateway-control-server.js";
import { DesktopControlClient, type DesktopGatewayConfig } from "@cjhyy/code-shell-chat/codeshell";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("desktop control protocol integration", () => {
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
    server.publish({
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
