import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { RemoteHostManager, resolveLanHost } from "./remote-host-manager.js";
import { TrustedDeviceStore } from "./trusted-device-store.js";
import { AccessPasscode } from "./access-passcode.js";

let dir: string | undefined;

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

describe("RemoteHostManager", () => {
  test("starts, serves mobile HTML, and stops", async () => {
    dir = mkdtempSync(join(tmpdir(), "remote-host-"));
    const host = new RemoteHostManager({
      devices: new TrustedDeviceStore(join(dir, "devices.json")),
      onClientEvent: () => {},
    });
    const started = await host.start({ host: "127.0.0.1", port: 0 });
    expect(started.url).toStartWith("http://127.0.0.1:");
    const res = await fetch(`${started.url}/mobile`);
    expect(res.status).toBe(200);
    const html = await res.text();
    // Structural markers that survive restyles (not the cosmetic <title>).
    expect(html).toContain("<title>CodeShell Remote</title>");
    expect(html).toContain('id="feed"');
    await host.stop();
  });

  test("creates pairing URL", async () => {
    dir = mkdtempSync(join(tmpdir(), "remote-host-"));
    const host = new RemoteHostManager({
      devices: new TrustedDeviceStore(join(dir, "devices.json")),
      onClientEvent: () => {},
    });
    const started = await host.start({ host: "127.0.0.1", port: 0 });
    const pairing = host.createPairingUrl();
    expect(pairing.url).toContain(`${started.url}/mobile?pairing=`);
    await host.stop();
  });

  test("pairs and authenticates a device over client events", async () => {
    dir = mkdtempSync(join(tmpdir(), "remote-host-"));
    const seen: unknown[] = [];
    const host = new RemoteHostManager({
      devices: new TrustedDeviceStore(join(dir, "devices.json")),
      onClientEvent: (event) => seen.push(event),
    });
    await host.start({ host: "127.0.0.1", port: 0 });
    const pairing = host.createPairingUrl();

    const paired = host.handleClientEvent({
      type: "pair.complete",
      token: pairing.token,
      name: "iPhone",
      secretHash: "h1",
    });
    expect(paired?.type).toBe("pair.ok");
    const device = paired?.type === "pair.ok" ? paired.device : undefined;
    expect(device?.name).toBe("iPhone");

    const authed = host.handleClientEvent({
      type: "auth.device",
      deviceId: device!.id,
      secretHash: "h1",
    });
    expect(authed?.type).toBe("auth.ok");
    await host.stop();
  });

  test("rejects auth for revoked device", async () => {
    dir = mkdtempSync(join(tmpdir(), "remote-host-"));
    const store = new TrustedDeviceStore(join(dir, "devices.json"));
    const host = new RemoteHostManager({ devices: store, onClientEvent: () => {} });
    await host.start({ host: "127.0.0.1", port: 0 });
    const pairing = host.createPairingUrl();
    const paired = host.handleClientEvent({
      type: "pair.complete",
      token: pairing.token,
      name: "iPhone",
      secretHash: "h1",
    });
    const device = paired?.type === "pair.ok" ? paired.device : undefined;
    store.revoke(device!.id);
    const authed = host.handleClientEvent({
      type: "auth.device",
      deviceId: device!.id,
      secretHash: "h1",
    });
    expect(authed?.type).toBe("auth.failed");
    await host.stop();
  });

  test("tracks online devices by socket refcount and emits online-change", () => {
    dir = mkdtempSync(join(tmpdir(), "remote-host-"));
    const host = new RemoteHostManager({
      devices: new TrustedDeviceStore(join(dir, "devices.json")),
      onClientEvent: () => {},
    });
    const events: string[][] = [];
    host.on("online-change", (ids: string[]) => events.push([...ids].sort()));

    expect(host.onlineDeviceIds()).toEqual([]);
    host.markOnline("dev1");
    expect(host.onlineDeviceIds()).toContain("dev1");
    // a second socket for the same device does not double-count nor re-emit a
    // membership change
    host.markOnline("dev1");
    host.markOnline("dev2");
    host.markOffline("dev1"); // still one socket left → dev1 stays online
    expect(host.onlineDeviceIds().sort()).toEqual(["dev1", "dev2"]);
    host.markOffline("dev1"); // last socket gone → dev1 offline
    expect(host.onlineDeviceIds()).toEqual(["dev2"]);

    // dev1 appears then disappears; dev2 appears → at least these transitions
    expect(events.some((e) => e.includes("dev1"))).toBe(true);
    expect(events[events.length - 1]).toEqual(["dev2"]);
  });

  test("resolveLanHost never returns loopback/link-local/VPN ranges", () => {
    const ip = resolveLanHost();
    // CI/sandbox may have no LAN interface → undefined is allowed.
    if (ip !== undefined) {
      expect(ip.startsWith("127.")).toBe(false);
      expect(ip.startsWith("169.254.")).toBe(false);
      expect(ip.startsWith("198.18.")).toBe(false);
    }
  });

  test("host 'lan' binds a non-loopback address when a LAN interface exists", async () => {
    dir = mkdtempSync(join(tmpdir(), "remote-host-"));
    const host = new RemoteHostManager({
      devices: new TrustedDeviceStore(join(dir, "devices.json")),
      onClientEvent: () => {},
    });
    const started = await host.start({ host: "lan", port: 0 });
    // Either a real LAN IP, or the documented localhost fallback if none found.
    expect(started.url).toMatch(/^http:\/\/(\d{1,3}\.){3}\d{1,3}:\d+$/);
    const res = await fetch(`${started.url}/mobile`);
    expect(res.status).toBe(200);
    await host.stop();
  });

  // ── Tunnel mode ───────────────────────────────────────────────────────────

  test("mode 'tunnel' binds 127.0.0.1 (never a LAN address)", async () => {
    dir = mkdtempSync(join(tmpdir(), "remote-host-"));
    const passcode = new AccessPasscode({ filePath: join(dir, "access.json") });
    passcode.set("correct");
    const host = new RemoteHostManager({
      devices: new TrustedDeviceStore(join(dir, "devices.json")),
      onClientEvent: () => {},
    });
    const started = await host.start({ mode: "tunnel", host: "lan", port: 0, passcode });
    expect(started.host).toBe("127.0.0.1");
    expect(started.url).toStartWith("http://127.0.0.1:");
    await host.stop();
  });

  test("tunnel mode: /mobile without a credential is gated (401)", async () => {
    dir = mkdtempSync(join(tmpdir(), "remote-host-"));
    const passcode = new AccessPasscode({ filePath: join(dir, "access.json") });
    passcode.set("correct");
    const host = new RemoteHostManager({
      devices: new TrustedDeviceStore(join(dir, "devices.json")),
      onClientEvent: () => {},
    });
    const started = await host.start({ mode: "tunnel", host: "lan", port: 0, passcode });
    const res = await fetch(`${started.url}/mobile`);
    expect(res.status).toBe(401);
    await host.stop();
  });

  test("tunnel mode: correct passcode query passes the gate and serves HTML", async () => {
    dir = mkdtempSync(join(tmpdir(), "remote-host-"));
    const passcode = new AccessPasscode({ filePath: join(dir, "access.json") });
    passcode.set("correct");
    const host = new RemoteHostManager({
      devices: new TrustedDeviceStore(join(dir, "devices.json")),
      onClientEvent: () => {},
    });
    const started = await host.start({ mode: "tunnel", host: "lan", port: 0, passcode });
    const res = await fetch(`${started.url}/mobile?passcode=correct`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('id="feed"');
    await host.stop();
  });

  test("tunnel mode: WS upgrade without a credential is rejected", async () => {
    dir = mkdtempSync(join(tmpdir(), "remote-host-"));
    const passcode = new AccessPasscode({ filePath: join(dir, "access.json") });
    passcode.set("correct");
    const host = new RemoteHostManager({
      devices: new TrustedDeviceStore(join(dir, "devices.json")),
      onClientEvent: () => {},
    });
    const started = await host.start({ mode: "tunnel", host: "lan", port: 0, passcode });
    const wsUrl = `${started.url.replace(/^http/, "ws")}/ws`;
    const code = await new Promise<number>((resolve) => {
      const ws = new WebSocket(wsUrl);
      ws.onopen = () => {
        ws.close();
        resolve(0); // unexpectedly opened
      };
      ws.onerror = () => resolve(-1);
      ws.onclose = (e) => resolve(e.code);
    });
    expect(code).not.toBe(0);
    await host.stop();
  });

  test("setPublicBaseUrl makes createPairingUrl use the tunnel domain", async () => {
    dir = mkdtempSync(join(tmpdir(), "remote-host-"));
    const passcode = new AccessPasscode({ filePath: join(dir, "access.json") });
    passcode.set("correct");
    const host = new RemoteHostManager({
      devices: new TrustedDeviceStore(join(dir, "devices.json")),
      onClientEvent: () => {},
    });
    await host.start({ mode: "tunnel", host: "lan", port: 0, passcode });
    host.setPublicBaseUrl("https://foo-bar.trycloudflare.com");
    const pairing = host.createPairingUrl();
    expect(pairing.url).toStartWith("https://foo-bar.trycloudflare.com/mobile?pairing=");
    await host.stop();
  });

  test("lan mode (no passcode) serves /mobile with no gate (regression)", async () => {
    dir = mkdtempSync(join(tmpdir(), "remote-host-"));
    const host = new RemoteHostManager({
      devices: new TrustedDeviceStore(join(dir, "devices.json")),
      onClientEvent: () => {},
    });
    const started = await host.start({ host: "127.0.0.1", port: 0 });
    const res = await fetch(`${started.url}/mobile`);
    expect(res.status).toBe(200);
    await host.stop();
  });
});
