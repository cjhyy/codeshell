import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
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
    expect(server.eventContext()?.streamId).toMatch(/^[a-f0-9]{32}$/);
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
    expect(server.eventContext()).toBeUndefined();
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

  test("routes Mimi Pet requests with proactive/direct channel capabilities", async () => {
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
        proactive: true,
        direct: true,
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
        proactive: true,
        direct: true,
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
          outbound: {
            proactive: true,
            direct: true,
            maxTextLength: 8_000,
            attachments: ["image", "file"],
          },
        },
        channels: [
          { channel: "telegram", capabilities: telegramCapabilities },
          { channel: "line", capabilities: lineCapabilities },
        ],
      },
    });
    expect(observed).toMatchObject({ message: "inspect", attachments: [{ id: "a" }] });

    const invalidCapabilityFlag = await fetch(`${descriptor.baseUrl}/v1/pet/chat`, {
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
          capabilities: {
            ...telegramCapabilities,
            outbound: { ...telegramCapabilities.outbound, proactive: "yes" },
          },
        },
      }),
    });
    expect(invalidCapabilityFlag.status).toBe(400);

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

  test("persists events before publication and resumes the same stream after restart", async () => {
    const root = mkdtempSync(join(tmpdir(), "codeshell-gateway-outbox-"));
    roots.push(root);
    const descriptorPath = join(root, "desktop-control.json");
    const outboxPath = `${descriptorPath}.events`;
    const first = makeServer(descriptorPath);
    const firstDescriptor = await first.start();
    const firstContext = first.eventContext();
    const deliveryKey = "a".repeat(64);
    const published = await first.publish({
      deliveryKey,
      type: "automation.completed",
      title: "Automation finished",
      text: "The scheduled work is ready.",
      target: { channel: "weixin", target: "opaque-owner-route" },
    });
    expect(published.id).toBe(1);
    expect(JSON.parse(readFileSync(outboxPath, "utf-8"))).toMatchObject({
      version: 2,
      streamId: firstContext?.streamId,
      acknowledgedEventId: 0,
      nextEventId: 2,
      events: [{ id: 1, deliveryKey, type: "automation.completed" }],
    });
    if (process.platform !== "win32") {
      expect(statSync(outboxPath).mode & 0o777).toBe(0o600);
    }
    const firstPage = await call(firstDescriptor, "GET", "/v1/events?after=0&waitMs=0");
    expect(await firstPage.json()).toMatchObject({
      streamId: firstContext?.streamId,
      cursor: 1,
      events: [{ id: 1, deliveryKey }],
    });
    await first.stop();

    const second = makeServer(descriptorPath);
    const secondDescriptor = await second.start();
    expect(second.eventContext()).toEqual(firstContext);
    const restoredPage = await call(secondDescriptor, "GET", "/v1/events?after=0&waitMs=0");
    expect(await restoredPage.json()).toMatchObject({
      streamId: firstContext?.streamId,
      cursor: 1,
      events: [{ id: 1, deliveryKey, text: "The scheduled work is ready." }],
    });
    expect(
      (await second.publish({ type: "automation.failed", text: "The next run failed." })).id,
    ).toBe(2);
    await second.stop();
  });

  test("flushes a publication accepted immediately before shutdown", async () => {
    const root = mkdtempSync(join(tmpdir(), "codeshell-gateway-stop-flush-"));
    roots.push(root);
    const descriptorPath = join(root, "desktop-control.json");
    const outboxPath = `${descriptorPath}.events`;
    const server = makeServer(descriptorPath);
    await server.start();

    const publication = server.publish({
      type: "automation.completed",
      text: "persist before shutdown",
    });
    const stopping = server.stop();

    await expect(publication).resolves.toMatchObject({ id: 1 });
    await stopping;
    expect(JSON.parse(readFileSync(outboxPath, "utf-8"))).toMatchObject({
      nextEventId: 2,
      events: [{ id: 1, text: "persist before shutdown" }],
    });
  });

  test("never trusts insecure or malformed event outboxes and quarantines them", async () => {
    const root = mkdtempSync(join(tmpdir(), "codeshell-gateway-outbox-invalid-"));
    roots.push(root);
    const descriptorPath = join(root, "desktop-control.json");
    const outboxPath = `${descriptorPath}.events`;
    const initial = makeServer(descriptorPath);
    await initial.start();
    const initialStreamId = initial.eventContext()?.streamId;
    await initial.stop();

    if (process.platform !== "win32") {
      chmodSync(outboxPath, 0o644);
      const insecure = makeServer(descriptorPath);
      await insecure.start();
      // Fail closed: the world-readable stream is abandoned, never resumed.
      expect(insecure.eventContext()?.streamId).not.toBe(initialStreamId);
      await insecure.stop();
    }
    writeFileSync(outboxPath, '{"version":1,"streamId":"forged"}\n', { mode: 0o600 });
    chmodSync(outboxPath, 0o600);
    const afterForged = makeServer(descriptorPath);
    await afterForged.start();
    expect(afterForged.eventContext()?.streamId).toMatch(/^[a-f0-9]{32}$/);
    await afterForged.stop();
    const quarantined = readdirSync(root).filter((name) => name.includes(".events.corrupt-"));
    expect(quarantined.length).toBe(process.platform === "win32" ? 1 : 2);
  });

  test("quarantines a corrupt event outbox instead of disabling the control plane", async () => {
    const root = mkdtempSync(join(tmpdir(), "codeshell-gateway-outbox-corrupt-"));
    roots.push(root);
    const descriptorPath = join(root, "desktop-control.json");
    const outboxPath = `${descriptorPath}.events`;
    const corruptContent = '{"version":2,"streamId":';
    writeFileSync(outboxPath, corruptContent, { mode: 0o600 });
    const server = makeServer(descriptorPath);

    // A truncated/corrupt events file must not brick pet chat RPC, tunnel
    // control, and notifications: the server starts and serves.
    const descriptor = await server.start();
    const status = await call(descriptor, "GET", "/v1/status");
    expect(status.status).toBe(200);

    // The bad file is renamed away beside the original for inspection.
    const quarantined = readdirSync(root).filter((name) => name.includes(".events.corrupt-"));
    expect(quarantined).toHaveLength(1);
    expect(readFileSync(join(root, quarantined[0]!), "utf-8")).toBe(corruptContent);

    // Publishing works against the fresh outbox.
    expect(server.eventContext()?.streamId).toMatch(/^[a-f0-9]{32}$/);
    expect((await server.publish({ type: "automation.completed", text: "fresh outbox" })).id).toBe(
      1,
    );
    expect(JSON.parse(readFileSync(outboxPath, "utf-8"))).toMatchObject({
      nextEventId: 2,
      events: [{ id: 1, text: "fresh outbox" }],
    });
    await server.stop();
  });

  test("does not expose an event when the atomic outbox replace fails", async () => {
    const root = mkdtempSync(join(tmpdir(), "codeshell-gateway-outbox-failure-"));
    roots.push(root);
    const descriptorPath = join(root, "desktop-control.json");
    const outboxPath = `${descriptorPath}.events`;
    const server = makeServer(descriptorPath);
    const descriptor = await server.start();
    rmSync(outboxPath);
    mkdirSync(outboxPath);

    await expect(
      server.publish({ type: "automation.completed", text: "Must not become visible" }),
    ).rejects.toThrow();
    const page = await call(descriptor, "GET", "/v1/events?after=0&waitMs=0");
    expect(await page.json()).toMatchObject({ cursor: 0, events: [] });
    await server.stop();
  });

  test("keeps the durable event publisher available when the HTTP control plane fails", async () => {
    const root = mkdtempSync(join(tmpdir(), "codeshell-gateway-control-failure-"));
    roots.push(root);
    const descriptorPath = join(root, "desktop-control.json");
    mkdirSync(descriptorPath);
    const server = makeServer(descriptorPath);

    await expect(server.start()).rejects.toThrow();
    expect(server.eventContext()?.streamId).toMatch(/^[a-f0-9]{32}$/);
    expect(
      (await server.publish({ type: "automation.completed", text: "Persist without HTTP" })).id,
    ).toBe(1);
    expect(JSON.parse(readFileSync(`${descriptorPath}.events`, "utf-8"))).toMatchObject({
      nextEventId: 2,
      events: [{ id: 1, text: "Persist without HTTP" }],
    });
    await server.stop();
    expect(server.eventContext()).toBeUndefined();
  });

  test("prunes only acknowledged prefixes and applies backpressure instead of dropping events", async () => {
    const root = mkdtempSync(join(tmpdir(), "codeshell-gateway-outbox-pressure-"));
    roots.push(root);
    const descriptorPath = join(root, "desktop-control.json");
    const outboxPath = `${descriptorPath}.events`;
    const streamId = "b".repeat(32);
    writeFileSync(
      outboxPath,
      `${JSON.stringify({
        version: 2,
        streamId,
        acknowledgedEventId: 0,
        nextEventId: 201,
        events: Array.from({ length: 200 }, (_, index) => ({
          id: index + 1,
          createdAt: index + 1,
          type: "automation.completed",
          text: `event-${index + 1}`,
        })),
      })}\n`,
      { mode: 0o600 },
    );
    if (process.platform !== "win32") chmodSync(outboxPath, 0o600);
    const server = makeServer(descriptorPath);
    const descriptor = await server.start();

    await expect(
      server.publish({ type: "automation.completed", text: "must wait for acknowledgement" }),
    ).rejects.toThrow("200 unacknowledged events");

    // A cursor from another/replaced stream must reveal this streamId without
    // deleting anything from the current outbox.
    const staleCursorPage = await call(descriptor, "GET", "/v1/events?after=999&waitMs=0");
    expect(await staleCursorPage.json()).toMatchObject({
      streamId,
      cursor: 999,
      resetCursor: true,
      events: [],
    });
    const afterStaleCursor = JSON.parse(readFileSync(outboxPath, "utf-8")) as {
      acknowledgedEventId: number;
      events: Array<{ id: number }>;
    };
    expect(afterStaleCursor.acknowledgedEventId).toBe(0);
    expect(afterStaleCursor.events).toHaveLength(200);
    expect(afterStaleCursor.events.at(0)?.id).toBe(1);
    expect(afterStaleCursor.events.at(-1)?.id).toBe(200);

    const acknowledgedPage = await call(descriptor, "GET", "/v1/events?after=100&waitMs=0");
    const page = (await acknowledgedPage.json()) as { events: Array<{ id: number }> };
    expect(page.events).toHaveLength(100);
    expect(page.events[0]?.id).toBe(101);
    expect(
      (await server.publish({ type: "automation.completed", text: "accepted after ack" })).id,
    ).toBe(201);
    const afterAcknowledgement = JSON.parse(readFileSync(outboxPath, "utf-8")) as {
      version: number;
      streamId: string;
      acknowledgedEventId: number;
      nextEventId: number;
      events: Array<{ id: number }>;
    };
    expect(afterAcknowledgement).toMatchObject({
      version: 2,
      streamId,
      acknowledgedEventId: 100,
      nextEventId: 202,
    });
    expect(afterAcknowledgement.events).toHaveLength(101);
    expect(afterAcknowledgement.events.at(0)?.id).toBe(101);
    expect(afterAcknowledgement.events.at(-1)?.id).toBe(201);
    await server.stop();

    const restored = makeServer(descriptorPath);
    const restoredDescriptor = await restored.start();
    expect(restored.eventContext()).toEqual({ streamId });
    const restoredPage = await call(restoredDescriptor, "GET", "/v1/events?after=100&waitMs=0");
    const restoredBody = (await restoredPage.json()) as {
      streamId: string;
      cursor: number;
      events: Array<{ id: number }>;
    };
    expect(restoredBody.streamId).toBe(streamId);
    expect(restoredBody.cursor).toBe(201);
    expect(restoredBody.events).toHaveLength(101);
    expect(restoredBody.events.at(0)?.id).toBe(101);
    expect(restoredBody.events.at(-1)?.id).toBe(201);
    await restored.stop();
  });

  test("lets serialized one-shot delivery acknowledge only the current outbox head", async () => {
    const root = mkdtempSync(join(tmpdir(), "codeshell-gateway-outbox-direct-ack-"));
    roots.push(root);
    const descriptorPath = join(root, "desktop-control.json");
    const outboxPath = `${descriptorPath}.events`;
    const server = makeServer(descriptorPath);
    await server.start();
    const first = await server.publish({ type: "automation.completed", text: "first" });
    const second = await server.publish({ type: "automation.completed", text: "second" });
    expect(first.deliveryKey).toMatch(/^[a-f0-9]{64}$/u);
    expect(second.deliveryKey).toMatch(/^[a-f0-9]{64}$/u);
    expect(second.deliveryKey).not.toBe(first.deliveryKey);

    expect(await server.acknowledgeDirectDelivery(second.id)).toBe(false);
    expect(await server.acknowledgeDirectDelivery(Number.NaN)).toBe(false);
    expect(await server.acknowledgeDirectDelivery(first.id)).toBe(true);
    let state = JSON.parse(readFileSync(outboxPath, "utf-8")) as {
      acknowledgedEventId: number;
      events: Array<{ id: number }>;
    };
    expect(state.acknowledgedEventId).toBe(first.id);
    expect(state.events.map(({ id }) => id)).toEqual([second.id]);

    expect(await server.acknowledgeDirectDelivery(second.id)).toBe(true);
    state = JSON.parse(readFileSync(outboxPath, "utf-8")) as typeof state;
    expect(state.acknowledgedEventId).toBe(second.id);
    expect(state.events).toEqual([]);
    expect(
      (await server.publish({ type: "automation.completed", text: "third after direct ack" })).id,
    ).toBe(3);
    await server.stop();
  });
});

function makeServer(descriptorPath: string): GatewayControlServer {
  return new GatewayControlServer({
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
}

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
