import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { TrustedDeviceStore } from "./trusted-device-store.js";

const TRUSTED_DEVICE_MODULE = join(import.meta.dir, "trusted-device-store.ts");

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

  // Revocation is a durable tombstone. A fresh pairing ceremony must not
  // silently resurrect the same browser credential; explicit removal is the
  // local approval step that permits that credential to pair again.
  test("a revoked credential stays revoked until its tombstone is removed", () => {
    dir = mkdtempSync(join(tmpdir(), "mobile-devices-"));
    const store = new TrustedDeviceStore(join(dir, "devices.json"));
    const first = store.addDevice({ name: "iPhone", secretHash: "hashA" });
    store.revoke(first.id);
    expect(() => store.addDevice({ name: "iPhone", secretHash: "hashA" })).toThrow(
      "Trusted device was revoked",
    );
    expect(store.listDevices()).toHaveLength(1);

    expect(store.remove(first.id)).toBe(true);
    const repaired = store.addDevice({ name: "iPhone", secretHash: "hashA" });
    expect(repaired.id).not.toBe(first.id);
    expect(store.listDevices()).toHaveLength(1);
  });

  test("remove() hard-deletes a device row (no zombie left in the list)", () => {
    dir = mkdtempSync(join(tmpdir(), "mobile-devices-"));
    const store = new TrustedDeviceStore(join(dir, "devices.json"));
    const a = store.addDevice({ name: "iPhone", secretHash: "hashA" });
    store.addDevice({ name: "iPad", secretHash: "hashB" });
    expect(store.remove(a.id)).toBe(true);
    expect(store.listDevices()).toHaveLength(1);
    expect(store.listDevices()[0]?.name).toBe("iPad");
    // removing a missing id is a no-op false
    expect(store.remove("nope")).toBe(false);
    // a removed device can no longer authenticate
    expect(store.authenticate(a.id, "hashA")).toBeUndefined();
  });

  // Y-3 hardening: secretHash is the device's bearer credential, compared with
  // timingSafeEqual (constant-time) instead of `===`. The comparison must stay
  // correct across all inputs — crucially, a wrong hash of a DIFFERENT LENGTH
  // must reject cleanly (return undefined), not throw, since timingSafeEqual
  // requires equal-length buffers.
  test("authenticate rejects a wrong-length secretHash without throwing (timing-safe)", () => {
    dir = mkdtempSync(join(tmpdir(), "mobile-devices-"));
    const store = new TrustedDeviceStore(join(dir, "devices.json"));
    const created = store.addDevice({ name: "iPhone", secretHash: "0123456789abcdef" });

    // correct hash → authenticates
    expect(store.authenticate(created.id, "0123456789abcdef")?.name).toBe("iPhone");
    // wrong hash, SAME length → rejected, no throw
    expect(store.authenticate(created.id, "fedcba9876543210")).toBeUndefined();
    // wrong hash, DIFFERENT length → rejected, no throw (the length-mismatch trap)
    expect(store.authenticate(created.id, "short")).toBeUndefined();
    expect(store.authenticate(created.id, "")).toBeUndefined();
    // wrong id → rejected
    expect(store.authenticate("nope", "0123456789abcdef")).toBeUndefined();
  });

  test("rename() changes a device's display name", () => {
    dir = mkdtempSync(join(tmpdir(), "mobile-devices-"));
    const store = new TrustedDeviceStore(join(dir, "devices.json"));
    const a = store.addDevice({ name: "iPhone", secretHash: "hashA" });
    expect(store.rename(a.id, "我的工作手机")).toBe(true);
    expect(store.listDevices()[0]?.name).toBe("我的工作手机");
    expect(store.rename("nope", "x")).toBe(false);
    // blank name is rejected
    expect(store.rename(a.id, "   ")).toBe(false);
    expect(store.rename(a.id, "x".repeat(513))).toBe(false);
    expect(store.rename(a.id, "bad\0name")).toBe(false);
    expect(store.listDevices()[0]?.name).toBe("我的工作手机");
  });

  test("rejects invalid direct-call inputs before they can grow the credential store", () => {
    dir = mkdtempSync(join(tmpdir(), "mobile-devices-inputs-"));
    const store = new TrustedDeviceStore(join(dir, "devices.json"));

    expect(() => store.addDevice({ name: "   ", secretHash: "secret" })).toThrow(
      "Invalid trusted device name",
    );
    expect(() => store.addDevice({ name: "phone", secretHash: "x".repeat(4_097) })).toThrow(
      "Invalid trusted device secret",
    );
    expect(store.authenticate("x".repeat(513), "secret")).toBeUndefined();
    expect(store.authenticate("id", "x".repeat(4_097))).toBeUndefined();
    expect(store.listDevices()).toEqual([]);
  });

  test("devices.json is written owner-only (0o600) — it holds the device secretHash", () => {
    dir = mkdtempSync(join(tmpdir(), "mobile-devices-mode-"));
    const file = join(dir, "devices.json");
    const store = new TrustedDeviceStore(file);
    store.addDevice({ name: "phone", secretHash: "sekret" });
    expect(statSync(file).mode & 0o777).toBe(0o600);

    chmodSync(file, 0o644);
    store.rename(store.listDevices()[0]!.id, "renamed");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readdirSync(dir).filter((name) => name.includes(".tmp"))).toEqual([]);
  });

  test("corrupt data fails closed and is never silently overwritten", () => {
    dir = mkdtempSync(join(tmpdir(), "mobile-devices-corrupt-"));
    const file = join(dir, "devices.json");
    const corrupt = JSON.stringify({ devices: "not-an-array" });
    writeFileSync(file, corrupt);
    const store = new TrustedDeviceStore(file);

    expect(() => store.listDevices()).toThrow("Trusted device store is corrupt");
    expect(() => store.authenticate("id", "secret")).toThrow("Trusted device store is corrupt");
    expect(() => store.addDevice({ name: "phone", secretHash: "secret" })).toThrow(
      "Trusted device store is corrupt",
    );
    expect(readFileSync(file, "utf-8")).toBe(corrupt);
  });

  test("oversized persisted fields fail closed instead of being loaded into authentication", () => {
    dir = mkdtempSync(join(tmpdir(), "mobile-devices-corrupt-field-"));
    const file = join(dir, "devices.json");
    const corrupt = JSON.stringify([
      {
        id: "id",
        name: "x".repeat(513),
        secretHash: "secret",
        createdAt: Date.now(),
      },
    ]);
    writeFileSync(file, corrupt);
    const store = new TrustedDeviceStore(file);

    expect(() => store.listDevices()).toThrow("Trusted device store is corrupt");
    expect(readFileSync(file, "utf-8")).toBe(corrupt);
  });

  test("refuses linked device files without reading or replacing their targets", () => {
    dir = mkdtempSync(join(tmpdir(), "mobile-devices-linked-"));
    const outside = join(dir, "outside.json");
    const file = join(dir, "devices.json");
    writeFileSync(outside, JSON.stringify([]));
    symlinkSync(outside, file);
    const store = new TrustedDeviceStore(file);

    expect(() => store.listDevices()).toThrow("Trusted device store is corrupt");
    expect(() => store.addDevice({ name: "phone", secretHash: "secret" })).toThrow(
      "Trusted device store is corrupt",
    );
    expect(JSON.parse(readFileSync(outside, "utf8"))).toEqual([]);
  });

  test("concurrent processes preserve every independently paired device", async () => {
    dir = mkdtempSync(join(tmpdir(), "mobile-devices-concurrent-"));
    const file = join(dir, "devices.json");
    const total = 16;
    const children = Array.from({ length: total }, (_, index) => {
      const script = `
          import { TrustedDeviceStore } from ${JSON.stringify(TRUSTED_DEVICE_MODULE)};
          new TrustedDeviceStore(${JSON.stringify(file)}).addDevice({
            name: ${JSON.stringify(`Phone ${index}`)},
            secretHash: ${JSON.stringify(`secret-${index}`)},
          });
        `;
      return Bun.spawn([process.execPath, "-e", script], {
        env: { ...process.env },
        stdout: "pipe",
        stderr: "pipe",
      });
    });
    expect(
      (await Promise.all(children.map((child) => child.exited))).every((code) => code === 0),
    ).toBe(true);
    const devices = new TrustedDeviceStore(file).listDevices();
    expect(devices).toHaveLength(total);
    expect(devices.map((device) => device.name).sort()).toEqual(
      Array.from({ length: total }, (_, index) => `Phone ${index}`).sort(),
    );
  }, 60_000);
});
