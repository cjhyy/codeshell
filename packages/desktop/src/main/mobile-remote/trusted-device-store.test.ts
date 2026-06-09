import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { TrustedDeviceStore } from "./trusted-device-store.js";

let dir: string | undefined;

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

describe("TrustedDeviceStore", () => {
  test("adds, lists, authenticates, and revokes devices", () => {
    dir = mkdtempSync(join(tmpdir(), "mobile-devices-"));
    const store = new TrustedDeviceStore(join(dir, "devices.json"));
    const created = store.addDevice({ name: "iPhone", secretHash: "hash1" });

    expect(store.listDevices()).toHaveLength(1);
    expect(store.authenticate(created.id, "hash1")?.name).toBe("iPhone");

    store.revoke(created.id);
    expect(store.authenticate(created.id, "hash1")).toBeUndefined();
    expect(store.listDevices()[0]?.revokedAt).toBeNumber();
  });

  // Regression: re-scanning the QR (same browser → same secretHash) used to
  // mint a new device each time, accumulating unboundedly. addDevice now
  // get-or-creates by secretHash.
  test("re-adding the same secretHash reuses the device instead of accumulating", () => {
    dir = mkdtempSync(join(tmpdir(), "mobile-devices-"));
    const store = new TrustedDeviceStore(join(dir, "devices.json"));
    const first = store.addDevice({ name: "iPhone", secretHash: "hashA" });
    const second = store.addDevice({ name: "iPhone (renamed)", secretHash: "hashA" });

    expect(store.listDevices()).toHaveLength(1);
    expect(second.id).toBe(first.id); // same row reused
    expect(store.listDevices()[0]?.name).toBe("iPhone (renamed)"); // name refreshed
    expect(second.lastSeenAt).toBeNumber();
  });

  test("a different secretHash still creates a distinct device", () => {
    dir = mkdtempSync(join(tmpdir(), "mobile-devices-"));
    const store = new TrustedDeviceStore(join(dir, "devices.json"));
    store.addDevice({ name: "iPhone", secretHash: "hashA" });
    store.addDevice({ name: "iPad", secretHash: "hashB" });
    expect(store.listDevices()).toHaveLength(2);
  });

  // A revoked device must not be reused — re-pairing after a revoke should
  // produce a fresh, non-revoked row.
  test("a revoked device is not reused; re-pairing creates a fresh row", () => {
    dir = mkdtempSync(join(tmpdir(), "mobile-devices-"));
    const store = new TrustedDeviceStore(join(dir, "devices.json"));
    const first = store.addDevice({ name: "iPhone", secretHash: "hashA" });
    store.revoke(first.id);
    const second = store.addDevice({ name: "iPhone", secretHash: "hashA" });
    expect(second.id).not.toBe(first.id);
    expect(store.listDevices()).toHaveLength(2);
  });
});
