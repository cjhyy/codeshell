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
});
