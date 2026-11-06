import { afterEach, expect, test } from "bun:test";
import { describeDevice, deviceStore } from "./storage";

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

// Runs first: a later test leaves a page-only name that reads would prefer.
test("the old platform-derived default is replaced, a chosen name is kept", () => {
  const nav = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      platform: "MacIntel",
      maxTouchPoints: 0,
      userAgent:
        "Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
    },
  });
  try {
    const fixture = installStorage({ writable: true });
    fixture.values.set("cs.deviceName", "MacIntel 浏览器");
    expect(deviceStore.getOrCreateName()).toBe("Mac · Safari");
    expect(fixture.values.get("cs.deviceName")).toBe("Mac · Safari");
    fixture.values.set("cs.deviceName", "我的 iPhone");
    expect(deviceStore.getOrCreateName()).toBe("我的 iPhone");
  } finally {
    if (nav) Object.defineProperty(globalThis, "navigator", nav);
    else delete (globalThis as { navigator?: unknown }).navigator;
  }
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

test("device names read as device · browser instead of navigator.platform", () => {
  const iphone =
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
  expect(describeDevice(iphone, "iPhone", 5)).toBe("iPhone · Safari");
  const ipad =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";
  expect(describeDevice(ipad, "MacIntel", 5)).toBe("iPad · Safari");
  expect(describeDevice(ipad, "MacIntel", 0)).toBe("Mac · Safari");
  expect(
    describeDevice(
      "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36",
      "Linux armv8l",
    ),
  ).toBe("Android · Chrome");
  expect(describeDevice("", "")).toBe("");
});
