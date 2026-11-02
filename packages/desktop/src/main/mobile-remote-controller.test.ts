import { afterEach, expect, test } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MobileRemoteController, suggestedComputerName } from "./mobile-remote-controller.js";
import { RelayPreferencesStore, type RelayRegistration } from "./device-relay-store.js";
import type { DeviceRelayConnectorOptions } from "@cjhyy/code-shell-server/remote-relay";
function setup() {
  let current: any;
  let startGate: Promise<void> | undefined;
  let stopped = 0;
  const states: unknown[] = [];
  const runningAtChange: boolean[] = [];
  const registration = {
    relayOrigin: "https://directory.example",
    publicOrigin: "https://computer.devices.example",
    hostId: randomUUID(),
    environmentId: randomUUID(),
    credential: randomBytes(32).toString("base64url"),
    credentialEpoch: 1,
    protocolVersion: 1 as const,
    name: "电脑",
  };
  let stored: typeof registration | undefined = registration;
  let preflightError = false;
  let forgetError = false;
  const controller = new MobileRemoteController({
    host: {
      status: () => current,
      start: async (options) => {
        await startGate;
        current = { url: "http://127.0.0.1:5678", port: 5678, mode: options.mode ?? "lan" };
        return current;
      },
      stop: async () => {
        stopped++;
        current = undefined;
      },
      createPairingUrl: () => ({ url: `${current.url}/mobile?pairing=one-time`, expiresAt: 123 }),
      onlineDeviceIds: () => [],
    } as any,
    tunnel: { isRunning: () => false, isConnected: () => false, stop: async () => {} } as any,
    binary: { ensureBinary: async () => {} } as any,
    passcode: { isSet: () => false } as any,
    store: {
      load: () => stored,
      forget: () => {
        if (forgetError) throw new Error("cannot delete");
        stored = undefined;
      },
      preflight: () => {
        if (preflightError) throw new Error("secure storage unavailable");
      },
    } as any,
    environmentDir: "/unused-because-preflight-fails",
    changed: (state) => {
      states.push(state);
      runningAtChange.push(!!current);
    },
  });
  return {
    controller,
    registration,
    states,
    runningAtChange,
    setGate: (gate: Promise<void>) => {
      startGate = gate;
    },
    failForget: () => {
      forgetError = true;
    },
    failPreflight: () => {
      preflightError = true;
    },
    stops: () => stopped,
  };
}
test("snapshot never includes computer credentials and loaded registration stays stopped", () => {
  const { controller, registration } = setup();
  const status = controller.relayStatus();
  expect(status.state).toBe("stopped");
  expect(status.registered).toBe(true);
  expect(JSON.stringify(status)).not.toContain(registration.credential);
  expect(controller.status().running).toBe(false);
});
test("stop fences a start already waiting for Host startup and leaves no listener", async () => {
  const { controller, setGate, stops } = setup();
  let resolve!: () => void;
  setGate(
    new Promise<void>((done) => {
      resolve = done;
    }),
  );
  const start = controller.start({ mode: "lan" });
  const outcome = start.then(
    () => "unexpected",
    () => "cancelled",
  );
  await new Promise((done) => setTimeout(done, 0));
  const stop = controller.stop();
  resolve();
  expect(await outcome).toBe("cancelled");
  await stop;
  expect(controller.status().running).toBe(false);
  expect(stops()).toBeGreaterThan(0);
});
test("LAN reuse is idempotent; forget stops transports; disposed controllers cannot restart", async () => {
  const { controller, stops } = setup();
  const first = await controller.start({ mode: "lan" });
  const count = stops();
  expect(await controller.start({ mode: "lan" })).toEqual(first);
  expect(stops()).toBe(count);
  await controller.forget();
  expect(controller.status().running).toBe(false);
  expect(controller.relayStatus().registered).toBe(false);
  await controller.dispose();
  await expect(controller.start()).rejects.toThrow("取消");
});
test("a successful LAN start notifies every settings view of the running gateway", async () => {
  // No registered relay: closing the previous transport publishes nothing, so
  // other windows learn about the new listener only from this notification.
  const { controller, runningAtChange } = setup();
  await controller.forget();
  runningAtChange.length = 0;
  await controller.start({ mode: "lan" });
  expect(controller.status().running).toBe(true);
  expect(runningAtChange.at(-1)).toBe(true);
});
test("safe-storage preflight runs before enrollment and preserves existing registration on preflight failure", async () => {
  const { controller, failPreflight } = setup();
  failPreflight();
  await expect(
    controller.enroll(
      {
        relayOrigin: "https://directory.example",
        ticket: randomBytes(32).toString("base64url"),
        name: "电脑",
      },
      () => true,
    ),
  ).rejects.toThrow("secure storage unavailable");
  expect(controller.relayStatus().registered).toBe(true);
  expect(controller.status().running).toBe(false);
});
test("public modes require the existing computer passcode", async () => {
  const { controller } = setup();
  await expect(controller.start({ mode: "relay" })).rejects.toThrow("口令");
  await expect(controller.start({ mode: "tunnel" })).rejects.toThrow("口令");
  expect(controller.status().running).toBe(false);
});

test("failed credential deletion stays fail-closed instead of reloading the forgotten registration", async () => {
  const { controller, failForget } = setup();
  expect(controller.relayStatus().registered).toBe(true);
  failForget();
  await expect(controller.forget()).rejects.toThrow("无法移除");
  for (let i = 0; i < 3; i++) {
    expect(controller.relayStatus()).toEqual({
      state: "storage-error",
      registered: false,
      autoConnect: false,
      suggestedName: expect.any(String),
    });
  }
  await controller.stop();
  expect(controller.relayStatus()).toEqual({
    state: "storage-error",
    registered: false,
    autoConnect: false,
    suggestedName: expect.any(String),
  });
});

// ── Startup reconnect and account pairing ──
const token = () => randomBytes(32).toString("base64url");
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function autoConnectSetup(options: { account?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "relay-auto-connect-"));
  roots.push(root);
  const origin = "https://account.example";
  const accountId = randomUUID();
  let saved: RelayRegistration | undefined = {
    relayOrigin: origin,
    publicOrigin: "https://computer.devices.example",
    hostId: randomUUID(),
    environmentId: randomUUID(),
    name: "Computer",
    protocolVersion: 1,
    credentialEpoch: 1,
    credential: token(),
    ...(options.account !== false
      ? { accountId, refreshToken: token(), credentialExpiresAt: Date.now() + 600_000 }
      : {}),
  };
  let current: any;
  let signedIn = true;
  let passcodeSet = true;
  let now = 1_000_000;
  let pairings = 0;
  const connectors: DeviceRelayConnectorOptions[] = [];
  let connectorState: "ready" | "unauthorized" = "ready";
  const preferences = new RelayPreferencesStore(join(root, "relay-preferences.json"));
  const controller = new MobileRemoteController({
    host: {
      status: () => current,
      start: async (input: any) => {
        current = { mode: input.mode ?? "lan", port: 1234, url: "http://127.0.0.1:1234" };
        return current;
      },
      stop: async () => {
        current = undefined;
      },
      onlineDeviceIds: () => [],
      relayTarget: () => ({
        port: 1234,
        signal: new AbortController().signal,
        setPublicBaseUrl: () => {},
      }),
      createPairingUrl: () => {
        pairings++;
        const value = token();
        return {
          token: value,
          url: `https://computer.devices.example/mobile?pairing=${value}`,
          expiresAt: now + 600_000,
        };
      },
    } as any,
    tunnel: { stop: async () => {}, isRunning: () => false, isConnected: () => false } as any,
    binary: {} as any,
    passcode: { isSet: () => passcodeSet } as any,
    store: {
      load: () => saved,
      save: (value: RelayRegistration) => {
        saved = value;
      },
      forget: () => {
        saved = undefined;
      },
    } as any,
    account: {
      status: () =>
        signedIn
          ? { state: "signed-in", origin, account: { id: accountId, username: "alice" } }
          : { state: "signed-out" },
    } as any,
    accountRequest: async () => ({}),
    connectorFactory: (input) => {
      connectors.push(input);
      return {
        start: () => queueMicrotask(() => input.onState?.(connectorState)),
        close: async () => {},
      };
    },
    preferences,
    computerName: () => "Alices-MacBook-Pro.local",
    now: () => now,
    environmentDir: "/unused",
    changed: () => {},
  });
  return {
    controller,
    connectors,
    preferences,
    root,
    host: () => current,
    setHost: (value: unknown) => {
      current = value;
    },
    signOut: () => {
      signedIn = false;
    },
    clearPasscode: () => {
      passcodeSet = false;
    },
    advance: (ms: number) => {
      now += ms;
    },
    rejectNextConnection: () => {
      connectorState = "unauthorized";
    },
    pairings: () => pairings,
    saved: () => saved,
  };
}

const settle = async () => {
  for (let i = 0; i < 10; i++) await new Promise((done) => setTimeout(done, 0));
};

test("auto-connect is off by default, requires a registration, and is reported in status", async () => {
  const { controller } = autoConnectSetup();
  expect(controller.relayStatus().autoConnect).toBe(false);
  expect(controller.relayStatus().suggestedName).toBe("Alices-MacBook-Pro");
  controller.autoStart();
  await settle();
  expect(controller.status().running).toBe(false);
  expect((await controller.setAutoConnect(true)).autoConnect).toBe(true);
  await controller.forget();
  expect(controller.relayStatus().autoConnect).toBe(false);
  await expect(controller.setAutoConnect(true)).rejects.toThrow("请先登记");
});

test("startup reconnects only an opted-in registration of the signed-in account and never displaces a running Host", async () => {
  const signedOut = autoConnectSetup();
  await signedOut.controller.setAutoConnect(true);
  signedOut.signOut();
  signedOut.controller.autoStart();
  await settle();
  expect(signedOut.connectors.length).toBe(0);
  expect(signedOut.saved()).toBeDefined();

  const noPasscode = autoConnectSetup();
  await noPasscode.controller.setAutoConnect(true);
  noPasscode.clearPasscode();
  noPasscode.controller.autoStart();
  await settle();
  expect(noPasscode.connectors.length).toBe(0);

  const lan = autoConnectSetup();
  await lan.controller.setAutoConnect(true);
  lan.setHost({ mode: "lan", port: 1, url: "http://192.168.1.2:1" });
  lan.controller.autoStart();
  await settle();
  expect(lan.connectors.length).toBe(0);
  expect(lan.host().mode).toBe("lan");

  const ready = autoConnectSetup();
  await ready.controller.setAutoConnect(true);
  ready.controller.autoStart();
  await settle();
  expect(ready.connectors.length).toBe(1);
  expect(ready.controller.relayStatus().state).toBe("ready");
  await ready.controller.dispose();
});

test("a revoked registration disables auto-connect", async () => {
  const { controller, rejectNextConnection, saved } = autoConnectSetup();
  await controller.setAutoConnect(true);
  rejectNextConnection();
  controller.autoStart();
  await settle();
  expect(saved()).toBeUndefined();
  expect(controller.relayStatus().autoConnect).toBe(false);
  await controller.dispose();
});

test("account pairing is offered only for account registrations, follows sign-out and is rate limited", async () => {
  const legacy = autoConnectSetup({ account: false });
  await legacy.controller.start({ mode: "relay" });
  expect(legacy.connectors[0].issuePairing).toBeUndefined();
  await legacy.controller.dispose();

  const account = autoConnectSetup();
  await account.controller.start({ mode: "relay" });
  // start() mints the Desktop's own QR pairing once.
  const baseline = account.pairings();
  const issue = account.connectors[0].issuePairing!;
  expect(typeof issue).toBe("function");
  for (let i = 0; i < 6; i++) expect(issue().token).toHaveLength(43);
  expect(() => issue()).toThrow();
  expect(account.pairings() - baseline).toBe(6);
  account.advance(60_000);
  expect(issue().token).toHaveLength(43);
  account.signOut();
  expect(() => issue()).toThrow();
  expect(account.pairings() - baseline).toBe(7);
  await account.controller.dispose();
});

test("preferences tolerate missing or foreign content", () => {
  const root = mkdtempSync(join(tmpdir(), "relay-preferences-"));
  roots.push(root);
  const store = new RelayPreferencesStore(join(root, "prefs.json"));
  expect(store.load()).toEqual({ autoConnect: false });
  writeFileSync(join(root, "prefs.json"), '{"autoConnect":"yes"}');
  expect(store.load()).toEqual({ autoConnect: false });
  store.save({ autoConnect: true });
  expect(store.load()).toEqual({ autoConnect: true });
});

test("suggested computer names are readable and bounded", () => {
  expect(suggestedComputerName("Alices-MacBook-Pro.local")).toBe("Alices-MacBook-Pro");
  expect(suggestedComputerName("\u0000")).toBe("CodeShell");
  expect(suggestedComputerName("x".repeat(200))).toHaveLength(80);
});
