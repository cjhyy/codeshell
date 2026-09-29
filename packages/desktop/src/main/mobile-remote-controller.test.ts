import { expect, test } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { MobileRemoteController } from "./mobile-remote-controller.js";
function setup() {
  let current: any;
  let startGate: Promise<void> | undefined;
  let stopped = 0;
  const states: unknown[] = [];
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
    changed: (state) => states.push(state),
  });
  return {
    controller,
    registration,
    states,
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
    expect(controller.relayStatus()).toEqual({ state: "storage-error", registered: false });
  }
  await controller.stop();
  expect(controller.relayStatus()).toEqual({ state: "storage-error", registered: false });
});
