import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { RemoteHostManager } from "./remote-host-manager.js";
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
    expect(await res.text()).toContain("CodeShell Mobile Remote");
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
});
