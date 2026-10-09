import { afterEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GatewayControlServer,
  type DesktopControlDescriptor,
  type GatewayControlServerOptions,
} from "./im-gateway-control-server.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("GatewayControlServer", () => {
  test("repairs a lost live descriptor with the same credential and stops recovery on shutdown", async () => {
    const root = mkdtempSync(join(tmpdir(), "codeshell-control-recovery-"));
    roots.push(root);
    const path = join(root, "desktop-control.json");
    const server = makeServer(path, { descriptorHealthCheckIntervalMs: 10 });
    try {
      const starting = server.start();
      expect(server.start()).toBe(starting);
      const descriptor = await starting;
      const context = server.eventContext();
      rmSync(path);
      await waitUntil(() => existsSync(path));
      expect(readDescriptor(path)).toEqual(descriptor);
      expect(server.eventContext()).toEqual(context);
      expect((await call(readDescriptor(path), "GET", "/v1/status")).status).toBe(200);

      writeFileSync(path, '{"version":', { mode: 0o600 });
      await waitUntil(() => {
        try {
          return readDescriptor(path).token === descriptor.token;
        } catch {
          return false;
        }
      });
      expect(await server.start()).toEqual(descriptor);
    } finally {
      await server.stop();
    }
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(existsSync(path)).toBe(false);
    expect(existsSync(`${path}.lock`)).toBe(false);
  });

  test("a second desktop profile cannot alter a shared live descriptor or outbox", async () => {
    const root = mkdtempSync(join(tmpdir(), "codeshell-control-shared-home-"));
    roots.push(root);
    const path = join(root, "desktop-control.json");
    const first = makeServer(path);
    const second = makeServer(path);
    try {
      const descriptor = await first.start();
      await first.publish({ type: "automation.completed", text: "owned event" });
      const outbox = readFileSync(`${path}.events`, "utf-8");
      await expect(second.start()).rejects.toThrow("Chat Gateway 已由");
      expect(second.eventContext()).toBeUndefined();
      await expect(
        second.publish({ type: "automation.completed", text: "unowned" }),
      ).rejects.toThrow("not started");
      await second.stop();
      expect(readDescriptor(path)).toEqual(descriptor);
      expect(readFileSync(`${path}.events`, "utf-8")).toBe(outbox);
      expect((await call(descriptor, "GET", "/v1/status")).status).toBe(200);
      await expect(second.start()).rejects.toThrow("Chat Gateway 已由");
      await first.stop();
      const replacement = await second.start();
      expect(replacement.token).not.toBe(descriptor.token);
      const events = await call(replacement, "GET", "/v1/events?after=0&waitMs=0");
      expect(await events.json()).toMatchObject({ events: [{ text: "owned event" }] });
    } finally {
      await second.stop();
      await first.stop();
    }
  });

  test("preserves a live legacy descriptor even when its desktop has no shared lease", async () => {
    const root = mkdtempSync(join(tmpdir(), "codeshell-control-legacy-owner-"));
    roots.push(root);
    const path = join(root, "desktop-control.json");
    const first = makeServer(path);
    const second = makeServer(path);
    try {
      const descriptor = await first.start();
      const outbox = readFileSync(`${path}.events`, "utf-8");
      rmSync(`${path}.lock`);
      await expect(second.start()).rejects.toThrow("belongs to a running desktop");
      expect(existsSync(`${path}.lock`)).toBe(false);
      await second.stop();
      expect(readDescriptor(path)).toEqual(descriptor);
      expect(readFileSync(`${path}.events`, "utf-8")).toBe(outbox);
      expect((await call(descriptor, "GET", "/v1/status")).status).toBe(200);
    } finally {
      await second.stop();
      await first.stop();
    }
  });

  test("a live legacy desktop gateway prevents replacing its missing control endpoint", async () => {
    const root = mkdtempSync(join(tmpdir(), "codeshell-control-legacy-gateway-"));
    roots.push(root);
    const path = join(root, "desktop-control.json");
    const gatewayLockPath = join(root, "gateway.lock");
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
    });
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    const server = makeServer(path);
    try {
      expect(child.pid).toBeDefined();
      const lease = legacyGatewayLease(child.pid!, "CodeShell Desktop");
      writeFileSync(gatewayLockPath, lease, { mode: 0o600 });
      // This is the migration failure: the old owner is alive, its descriptor
      // is absent, and its retained outbox must remain wholly untouched.
      const retained = "retained old desktop outbox";
      writeFileSync(`${path}.events`, retained, { mode: 0o600 });
      await expect(server.start()).rejects.toThrow("owned by a running legacy desktop");
      await server.stop();
      expect(existsSync(path)).toBe(false);
      expect(existsSync(`${path}.lock`)).toBe(false);
      expect(readFileSync(`${path}.events`, "utf-8")).toBe(retained);
      expect(readFileSync(gatewayLockPath, "utf-8")).toBe(lease);
      expect(readdirSync(root).some((name) => name.includes(".corrupt-"))).toBe(false);
    } finally {
      await server.stop();
      child.kill();
      await exited;
    }
  });

  test("permits a live CLI gateway to launch desktop control and supports a configured lock path", async () => {
    const root = mkdtempSync(join(tmpdir(), "codeshell-control-cli-gateway-"));
    roots.push(root);
    const path = join(root, "desktop-control.json");
    const gatewayLockPath = join(root, "custom-runtime.lock");
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
    });
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    const server = makeServer(path, { legacyDesktopGatewayLockPath: gatewayLockPath });
    try {
      expect(child.pid).toBeDefined();
      const desktopLease = legacyGatewayLease(child.pid!, "CodeShell Desktop");
      writeFileSync(gatewayLockPath, desktopLease, { mode: 0o600 });
      await expect(server.start()).rejects.toThrow("owned by a running legacy desktop");
      const cliLease = legacyGatewayLease(child.pid!, "code-shell-chat CLI");
      writeFileSync(gatewayLockPath, cliLease, { mode: 0o600 });
      const descriptor = await server.start();
      expect((await call(descriptor, "GET", "/v1/status")).status).toBe(200);
      await server.stop();
      expect(readFileSync(gatewayLockPath, "utf-8")).toBe(cliLease);
    } finally {
      await server.stop();
      child.kill();
      await exited;
    }
  });

  test("fails closed on malformed, oversized or symlinked legacy gateway locks", async () => {
    const root = mkdtempSync(join(tmpdir(), "codeshell-control-unsafe-gateway-lock-"));
    roots.push(root);
    const path = join(root, "desktop-control.json");
    const lockPath = join(root, "gateway.lock");
    const server = makeServer(path);
    writeFileSync(lockPath, "{", { mode: 0o600 });
    await expect(server.start()).rejects.toThrow("legacy instance lock is invalid");
    writeFileSync(lockPath, "x".repeat(64 * 1024 + 1), { mode: 0o600 });
    await expect(server.start()).rejects.toThrow("exceeds its size limit");
    rmSync(lockPath);
    const target = join(root, "target.lock");
    const lease = legacyGatewayLease(process.pid, "code-shell-chat CLI");
    writeFileSync(target, lease, { mode: 0o600 });
    symlinkSync(target, lockPath);
    await expect(server.start()).rejects.toThrow("not a regular file");
    await server.stop();
    expect(lstatSync(lockPath).isSymbolicLink()).toBe(true);
    expect(readFileSync(target, "utf-8")).toBe(lease);
    expect(existsSync(path)).toBe(false);
    expect(existsSync(`${path}.events`)).toBe(false);
    expect(existsSync(`${path}.lock`)).toBe(false);
  });

  test("reclaims a descriptor and lease whose desktop process is gone", async () => {
    const root = mkdtempSync(join(tmpdir(), "codeshell-control-stale-owner-"));
    roots.push(root);
    const path = join(root, "desktop-control.json");
    const deadPid = 2_147_483_647;
    expect(() => process.kill(deadPid, 0)).toThrow();
    const stale = {
      version: 1,
      pid: deadPid,
      baseUrl: "http://127.0.0.1:1",
      token: "a".repeat(64),
      startedAt: 1,
    };
    writeFileSync(path, JSON.stringify(stale), { mode: 0o600 });
    writeFileSync(
      `${path}.lock`,
      JSON.stringify({
        version: 1,
        pid: deadPid,
        owner: "stale desktop",
        token: "11111111-1111-4111-8111-111111111111",
        startedAt: 1,
      }),
      { mode: 0o600 },
    );
    const server = makeServer(path);
    try {
      const descriptor = await server.start();
      expect(descriptor.token).not.toBe(stale.token);
      expect(readDescriptor(path)).toEqual(descriptor);
    } finally {
      await server.stop();
    }
  });

  test("periodic recovery and repeated start preserve a competing live descriptor", async () => {
    const root = mkdtempSync(join(tmpdir(), "codeshell-control-competing-owner-"));
    roots.push(root);
    const path = join(root, "desktop-control.json");
    const server = makeServer(path, { descriptorHealthCheckIntervalMs: 10 });
    const descriptor = await server.start();
    const competing = { ...descriptor, token: "b".repeat(64) };
    writeFileSync(path, JSON.stringify(competing), { mode: 0o600 });
    try {
      await new Promise((resolve) => setTimeout(resolve, 40));
      expect(readDescriptor(path)).toEqual(competing);
      await expect(server.start()).rejects.toThrow("belongs to a running desktop");
      expect((await call(descriptor, "GET", "/v1/status")).status).toBe(200);
    } finally {
      await server.stop();
    }
    expect(readDescriptor(path)).toEqual(competing);
  });

  test("never replaces a descriptor symlink during startup, recovery or cleanup", async () => {
    const root = mkdtempSync(join(tmpdir(), "codeshell-control-symlink-"));
    roots.push(root);
    const path = join(root, "desktop-control.json");
    const target = join(root, "target.json");
    const server = makeServer(path, { descriptorHealthCheckIntervalMs: 10 });
    const descriptor = await server.start();
    writeFileSync(target, JSON.stringify(descriptor), { mode: 0o600 });
    rmSync(path);
    symlinkSync(target, path);
    try {
      await new Promise((resolve) => setTimeout(resolve, 40));
      expect(lstatSync(path).isSymbolicLink()).toBe(true);
      await expect(server.start()).rejects.toThrow("not a regular file");
    } finally {
      await server.stop();
    }
    expect(lstatSync(path).isSymbolicLink()).toBe(true);
    expect(readDescriptor(target)).toEqual(descriptor);
    const restarted = makeServer(path);
    await expect(restarted.start()).rejects.toThrow("not a regular file");
    expect(existsSync(`${path}.lock`)).toBe(false);
    expect(readDescriptor(target)).toEqual(descriptor);
    await restarted.stop();
  });

  test("stop during startup closes the eventual listener and releases shared ownership", async () => {
    const root = mkdtempSync(join(tmpdir(), "codeshell-control-start-stop-"));
    roots.push(root);
    const path = join(root, "desktop-control.json");
    const first = makeServer(path, { descriptorHealthCheckIntervalMs: 10 });
    const starting = first.start();
    const stopping = first.stop();
    const descriptor = await starting;
    await stopping;
    expect(existsSync(path)).toBe(false);
    expect(existsSync(`${path}.lock`)).toBe(false);
    await expect(call(descriptor, "GET", "/v1/status")).rejects.toThrow();
    const second = makeServer(path);
    try {
      await second.start();
    } finally {
      await second.stop();
    }
  });

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
          isDirectMessage: true,
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
        isDirectMessage: true,
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

    const invalidPrivateFlag = await fetch(`${descriptor.baseUrl}/v1/pet/chat`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${descriptor.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        message: "enter",
        origin: {
          channel: "slack",
          target: "D-chat",
          senderId: "U-owner",
          isDirectMessage: "true",
          capabilities: telegramCapabilities,
        },
      }),
    });
    expect(invalidPrivateFlag.status).toBe(400);

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
    await expect(
      server.publish({ type: "automation.completed", text: "arrived during shutdown" }),
    ).rejects.toThrow("not started");

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

  test("releases ownership after a startup failure and rejects unowned event publication", async () => {
    const root = mkdtempSync(join(tmpdir(), "codeshell-gateway-control-failure-"));
    roots.push(root);
    const descriptorPath = join(root, "desktop-control.json");
    mkdirSync(descriptorPath);
    const server = makeServer(descriptorPath);

    await expect(server.start()).rejects.toThrow();
    expect(server.eventContext()).toBeUndefined();
    expect(existsSync(`${descriptorPath}.lock`)).toBe(false);
    expect(existsSync(`${descriptorPath}.events`)).toBe(false);
    await expect(
      server.publish({ type: "automation.completed", text: "Persist without ownership" }),
    ).rejects.toThrow("not started");
    rmSync(descriptorPath, { recursive: true });
    const descriptor = await server.start();
    expect((await call(descriptor, "GET", "/v1/status")).status).toBe(200);
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

function makeServer(
  descriptorPath: string,
  options: Partial<GatewayControlServerOptions> = {},
): GatewayControlServer {
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
    ...options,
  });
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for descriptor recovery");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function legacyGatewayLease(pid: number, owner: string): string {
  return JSON.stringify({
    version: 1,
    pid,
    owner,
    token: "11111111-1111-4111-8111-111111111111",
    startedAt: 1,
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
