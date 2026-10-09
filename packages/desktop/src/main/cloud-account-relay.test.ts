import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { randomBytes, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MobileRemoteController } from "./mobile-remote-controller.js";
import type { RelayRegistration } from "./device-relay-store.js";

const token = () => randomBytes(32).toString("base64url");
test("account enrollment uses only the signed-in origin, does not start sharing, and logout preserves an active LAN Host", async () => {
  const root = mkdtempSync(join(tmpdir(), "cloud-account-relay-"));
  const origin = "https://account.example",
    accountId = randomUUID(),
    managementToken = token();
  let saved: RelayRegistration | undefined,
    current: any,
    starts = 0;
  const calls: any[] = [];
  const controller = new MobileRemoteController({
    host: {
      status: () => current,
      start: async (input) => {
        starts++;
        current = { mode: input.mode ?? "lan", url: "http://127.0.0.1:1234", port: 1234 };
        return current;
      },
      stop: async () => {
        current = undefined;
      },
      onlineDeviceIds: () => [],
      createPairingUrl: () => ({ url: "http://127.0.0.1:1234/mobile?pairing=one", expiresAt: 123 }),
    } as any,
    tunnel: { stop: async () => {}, isRunning: () => false, isConnected: () => false } as any,
    binary: {} as any,
    passcode: { isSet: () => false } as any,
    store: {
      load: () => saved,
      save: (value) => {
        saved = value;
      },
      forget: () => {
        saved = undefined;
      },
      preflight: () => {},
    } as any,
    account: {
      status: () => ({ state: "signed-in", origin, account: { id: accountId, username: "alice" } }),
      getCredential: async (requestedOrigin, id) => {
        expect(requestedOrigin).toBe(origin);
        expect(id).toBe(accountId);
        return managementToken;
      },
    } as any,
    accountRequest: async (input) => {
      calls.push(input);
      return {
        hostId: randomUUID(),
        environmentId: (input.body as any).environmentId,
        publicOrigin: "https://computer.devices.example",
        credential: token(),
        refreshToken: token(),
        credentialExpiresAt: Date.now() + 600_000,
        credentialEpoch: 1,
        protocolVersion: 1,
        accountId,
      };
    },
    environmentDir: root,
    changed: () => {},
  });
  try {
    await expect(
      controller.enroll(
        { authorization: "account", relayOrigin: "https://evil.example", name: "Computer" },
        () => true,
      ),
    ).rejects.toThrow();
    expect(calls).toHaveLength(0);
    const result = await controller.enroll(
      { authorization: "account", relayOrigin: origin, name: "Computer" },
      () => true,
    );
    expect(result.accountId).toBe(accountId);
    expect(starts).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0].origin).toBe(origin);
    expect(calls[0].token).toBe(managementToken);
    expect(calls[0].body).not.toHaveProperty("ticket");
    expect(JSON.stringify(result)).not.toContain(saved!.credential);
    expect(JSON.stringify(result)).not.toContain(saved!.refreshToken);
    await controller.start({ mode: "lan" });
    await controller.retireAccountRelay({ origin, accountId });
    expect(controller.status().running).toBe(true);
    expect(controller.status().mode).toBe("lan");
    expect(controller.relayStatus().registered).toBe(false);
    expect(saved).toBeUndefined();
  } finally {
    await controller.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test("stopping during a committed device refresh preserves its rotated credential for resume; logout fences and revokes a late device grant", async () => {
  const origin = "https://account.example",
    accountId = randomUUID(),
    hostId = randomUUID();
  let saved: RelayRegistration | undefined = {
    relayOrigin: origin,
    publicOrigin: "https://computer.devices.example",
    accountId,
    hostId,
    environmentId: randomUUID(),
    name: "Computer",
    protocolVersion: 1,
    credentialEpoch: 1,
    credential: token(),
    refreshToken: token(),
    credentialExpiresAt: Date.now() + 1000,
  };
  let current: any,
    accountActive = true,
    release!: (value: any) => void,
    refreshes = 0;
  const requests: any[] = [];
  const controller = new MobileRemoteController({
    host: {
      status: () => current,
      start: async () => {
        current = { mode: "relay", port: 1234 };
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
      createPairingUrl: () => ({
        url: "https://computer.devices.example/mobile?pairing=one",
        expiresAt: 123,
      }),
    } as any,
    tunnel: { stop: async () => {}, isRunning: () => false, isConnected: () => false } as any,
    binary: {} as any,
    passcode: { isSet: () => true } as any,
    store: {
      load: () => saved,
      save: (value) => {
        saved = value;
      },
      forget: () => {
        saved = undefined;
      },
    } as any,
    account: {
      status: () =>
        accountActive
          ? { state: "signed-in", origin, account: { id: accountId, username: "alice" } }
          : { state: "signed-out" },
    } as any,
    accountRequest: async (input) => {
      requests.push(input);
      if (input.path.endsWith("refresh")) {
        refreshes++;
        return new Promise((done) => {
          release = done;
        });
      }
      return {};
    },
    connectorFactory: (options) => {
      const abort = new AbortController();
      let closed = false;
      return {
        start: () => {
          void options.getCredential!(abort.signal)
            .then(() => {
              if (!closed) options.onState?.("ready");
            })
            .catch(() => {});
        },
        close: async () => {
          closed = true;
          abort.abort();
        },
      };
    },
    environmentDir: "/unused",
    changed: () => {},
  });
  const nextGrant = () => ({
    kind: "device",
    hostId,
    audience: origin,
    account: { id: accountId, username: "alice" },
    sessionId: randomUUID(),
    accessToken: token(),
    refreshToken: token(),
    accessTokenExpiresAt: Date.now() + 600_000,
    refreshTokenExpiresAt: Date.now() + 86400_000,
  });
  try {
    const initial = controller.start({ mode: "relay" }).catch(() => "cancelled");
    while (!release) await new Promise((done) => setTimeout(done, 0));
    await controller.stop();
    expect(await initial).toBe("cancelled");
    const rotated = nextGrant();
    release(rotated);
    await new Promise((done) => setTimeout(done, 0));
    expect(saved!.credential).toBe(rotated.accessToken);
    expect(saved!.refreshToken).toBe(rotated.refreshToken);
    expect(controller.status().running).toBe(false);
    await controller.start({ mode: "relay" });
    expect(refreshes).toBe(1);
    await controller.stop();

    saved!.credentialExpiresAt = Date.now();
    release = undefined as any;
    const again = controller.start({ mode: "relay" }).catch(() => "cancelled");
    while (!release) await new Promise((done) => setTimeout(done, 0));
    accountActive = false;
    await controller.retireAccountRelay({ origin, accountId });
    expect(await again).toBe("cancelled");
    const late = nextGrant();
    release(late);
    await new Promise((done) => setTimeout(done, 0));
    expect(saved).toBeUndefined();
    expect(controller.relayStatus().registered).toBe(false);
    expect(
      requests.some((req) => req.path.endsWith("logout") && req.token === late.accessToken),
    ).toBe(true);
  } finally {
    await controller.dispose();
  }
});
