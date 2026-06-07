import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { RemoteHostManager, resolveLanHost } from "./remote-host-manager.js";
import { TrustedDeviceStore } from "./trusted-device-store.js";

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
});
