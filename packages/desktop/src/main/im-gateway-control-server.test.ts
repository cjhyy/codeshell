import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GatewayControlServer,
  type DesktopControlDescriptor,
} from "./im-gateway-control-server.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("GatewayControlServer", () => {
  test("writes an owner-only descriptor and requires its bearer token", async () => {
    const root = mkdtempSync(join(tmpdir(), "codeshell-gateway-control-"));
    roots.push(root);
    const descriptorPath = join(root, "nested", "desktop-control.json");
    const server = new GatewayControlServer({
      descriptorPath,
      open: async () => ({
        url: "https://example.trycloudflare.com",
        pairingUrl: "https://example.trycloudflare.com/mobile?pairing=secret",
        expiresAt: 123,
        mode: "tunnel",
      }),
      close: async () => undefined,
      status: () => ({
        running: false,
        tunnelRunning: false,
        tunnelConnected: false,
        passcodeSet: true,
        onlineDeviceCount: 0,
      }),
      pairingUrl: async () => ({ pairingUrl: "https://example.test/mobile", expiresAt: 456 }),
    });

    const descriptor = await server.start();
    expect(readDescriptor(descriptorPath)).toEqual(descriptor);
    if (process.platform !== "win32") {
      expect(statSync(descriptorPath).mode & 0o777).toBe(0o600);
      expect(statSync(join(root, "nested")).mode & 0o777).toBe(0o700);
    }

    const unauthorized = await fetch(`${descriptor.baseUrl}/v1/status`);
    expect(unauthorized.status).toBe(401);

    const authorized = await call(descriptor, "GET", "/v1/status");
    expect(authorized.status).toBe(200);
    expect(await authorized.json()).toMatchObject({ passcodeSet: true, onlineDeviceCount: 0 });

    await server.stop();
    expect(() => readFileSync(descriptorPath)).toThrow();
  });

  test("routes open, close, and pairing operations without exposing Electron IPC", async () => {
    const root = mkdtempSync(join(tmpdir(), "codeshell-gateway-routes-"));
    roots.push(root);
    let closes = 0;
    const server = new GatewayControlServer({
      descriptorPath: join(root, "desktop-control.json"),
      open: async () => ({
        url: "https://demo.trycloudflare.com",
        pairingUrl: "https://demo.trycloudflare.com/mobile?pairing=one-use",
        expiresAt: 1000,
        mode: "tunnel",
      }),
      close: async () => {
        closes++;
      },
      status: () => ({
        running: true,
        mode: "tunnel",
        tunnelRunning: true,
        tunnelConnected: true,
        passcodeSet: true,
        onlineDeviceCount: 2,
      }),
      pairingUrl: async () => ({
        pairingUrl: "https://demo.trycloudflare.com/mobile?pairing=fresh",
        expiresAt: 2000,
      }),
    });
    const descriptor = await server.start();

    const opened = await call(descriptor, "POST", "/v1/open");
    expect(await opened.json()).toMatchObject({ mode: "tunnel", expiresAt: 1000 });

    const pairing = await call(descriptor, "POST", "/v1/pairing-url");
    expect(await pairing.json()).toMatchObject({ expiresAt: 2000 });

    const closed = await call(descriptor, "POST", "/v1/close");
    expect(await closed.json()).toEqual({ closed: true });
    expect(closes).toBe(1);
    await server.stop();
  });

  test("validates and routes bounded Mimi Pet text and attachment requests", async () => {
    const root = mkdtempSync(join(tmpdir(), "codeshell-gateway-pet-"));
    roots.push(root);
    let observed: unknown;
    const server = new GatewayControlServer({
      descriptorPath: join(root, "desktop-control.json"),
      open: async () => ({
        url: "https://demo.trycloudflare.com",
        pairingUrl: "https://demo.trycloudflare.com/mobile?pairing=x",
        expiresAt: 1000,
        mode: "tunnel",
      }),
      close: async () => undefined,
      status: () => ({
        running: false,
        tunnelRunning: false,
        tunnelConnected: false,
        passcodeSet: true,
        onlineDeviceCount: 0,
      }),
      pairingUrl: async () => ({ pairingUrl: "https://demo.test/mobile", expiresAt: 1000 }),
      petChat: async (request) => {
        observed = request;
        return {
          text: "done",
          petSessionId: "pet-1",
          button: { text: "Open", url: "https://example.test/result" },
          attachments: [
            {
              kind: "image",
              name: "pairing-qr.png",
              mimeType: "image/png",
              size: 4,
              path: join(root, "pairing-qr.png"),
            },
          ],
        };
      },
    });
    const descriptor = await server.start();
    const telegramCapabilities = {
      inbound: {
        text: true as const,
        attachments: ["image", "file", "audio", "video"] as const,
      },
      outbound: {
        text: true as const,
        maxTextLength: 8_000,
        button: "native" as const,
        attachments: ["image", "file"] as const,
        maxAttachments: 4,
        maxAttachmentBytes: 10 * 1024 * 1024,
      },
    };
    const lineCapabilities = {
      inbound: {
        text: true as const,
        attachments: ["image", "file", "audio", "video"] as const,
      },
      outbound: {
        text: true as const,
        maxTextLength: 8_000,
        button: "native" as const,
        attachments: [] as const,
      },
    };
    const response = await fetch(`${descriptor.baseUrl}/v1/pet/chat`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${descriptor.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        message: "inspect",
        attachments: [{ id: "a", kind: "file", size: 2, dataBase64: "aGk=" }],
        origin: {
          channel: "telegram",
          target: "owner-chat",
          senderId: "owner",
          capabilities: telegramCapabilities,
          channels: [
            { channel: "telegram", capabilities: telegramCapabilities },
            { channel: "line", capabilities: lineCapabilities },
          ],
        },
      }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      text: "done",
      petSessionId: "pet-1",
      button: { text: "Open", url: "https://example.test/result" },
      attachments: [{ name: "pairing-qr.png", path: join(root, "pairing-qr.png") }],
    });
    expect(observed).toMatchObject({
      origin: {
        channel: "telegram",
        capabilities: {
          outbound: { maxTextLength: 8_000, attachments: ["image", "file"] },
        },
        channels: [
          { channel: "telegram", capabilities: telegramCapabilities },
          { channel: "line", capabilities: lineCapabilities },
        ],
      },
    });
    expect(observed).toMatchObject({ message: "inspect", attachments: [{ id: "a" }] });

    const invalidCatalog = await fetch(`${descriptor.baseUrl}/v1/pet/chat`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${descriptor.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        message: "inspect",
        origin: {
          channel: "telegram",
          target: "owner-chat",
          senderId: "owner",
          capabilities: telegramCapabilities,
          channels: [{ channel: "line", capabilities: lineCapabilities }],
        },
      }),
    });
    expect(invalidCatalog.status).toBe(400);

    const contradictoryCatalog = await fetch(`${descriptor.baseUrl}/v1/pet/chat`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${descriptor.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        message: "inspect",
        origin: {
          channel: "telegram",
          target: "owner-chat",
          senderId: "owner",
          capabilities: telegramCapabilities,
          channels: [{ channel: "telegram", capabilities: lineCapabilities }],
        },
      }),
    });
    expect(contradictoryCatalog.status).toBe(400);

    const invalid = await fetch(`${descriptor.baseUrl}/v1/pet/chat`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${descriptor.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ message: "" }),
    });
    expect(invalid.status).toBe(400);
    await server.stop();
  });
});

function readDescriptor(path: string): DesktopControlDescriptor {
  return JSON.parse(readFileSync(path, "utf-8")) as DesktopControlDescriptor;
}

function call(
  descriptor: DesktopControlDescriptor,
  method: "GET" | "POST",
  path: string,
): Promise<Response> {
  return fetch(`${descriptor.baseUrl}${path}`, {
    method,
    headers: { authorization: `Bearer ${descriptor.token}` },
  });
}
