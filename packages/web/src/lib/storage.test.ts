import { afterEach, expect, test } from "bun:test";
import { deviceStore } from "./storage";

const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");

function installStorage(options: { writable: boolean; readable?: boolean }) {
  const values = new Map<string, string>();
  const storage = {
    getItem(key: string) {
      if (options.readable === false) throw new Error("SecurityError");
      return values.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      if (!options.writable) throw new DOMException("quota", "QuotaExceededError");
      values.set(key, value);
    },
    removeItem(key: string) {
      values.delete(key);
    },
  };
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
  return { values, storage, options };
}

afterEach(() => {
  deviceStore.clearId();
  if (original) Object.defineProperty(globalThis, "localStorage", original);
  else delete (globalThis as { localStorage?: unknown }).localStorage;
});

test("a secret minted while storage is full stays the same for the whole page", () => {
  const { values } = installStorage({ writable: false });
  let minted = 0;
  const mint = () => `secret-${++minted}`;
  // Pairing and the following authentication each ask for the secret.
  const paired = deviceStore.getOrCreateSecret(mint);
  const authenticated = deviceStore.getOrCreateSecret(mint);
  expect(authenticated).toBe(paired);
  expect(minted).toBe(1);
  expect(values.size).toBe(0);
  deviceStore.setId("device-1");
  expect(deviceStore.getId()).toBe("device-1");
  deviceStore.clearId();
  expect(deviceStore.getId()).toBe("");
});

test("unreadable storage falls back to the page's values instead of throwing", () => {
  installStorage({ writable: false, readable: false });
  const secret = deviceStore.getOrCreateSecret(() => "page-secret");
  expect(deviceStore.getOrCreateSecret(() => "other")).toBe(secret);
  expect(deviceStore.getOrCreateName()).toBe(deviceStore.getOrCreateName());
});

test("a persisted value written later replaces the page fallback", () => {
  const fixture = installStorage({ writable: false });
  deviceStore.setId("memory-only");
  fixture.options.writable = true;
  deviceStore.setId("persisted");
  expect(fixture.values.get("cs.deviceId")).toBe("persisted");
  expect(deviceStore.getId()).toBe("persisted");
});
