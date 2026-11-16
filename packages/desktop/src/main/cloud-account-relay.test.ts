import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MobileRemoteController } from "./mobile-remote-controller.js";
import { CloudAccountHttpError } from "./cloud-account-http.js";
import type { RelayRegistration } from "./device-relay-store.js";
import { EventEmitter } from "node:events";
import { AccountDeviceService, type AccountDeviceIdentity } from "./account-device-service.js";
import type { AccountDeviceEvent } from "../shared/account-device.js";
import { createAccountRemoteAuthorizer } from "./account-device-passkey.js";

const token = () => randomBytes(32).toString("base64url");

function passkeyBrokerFixture(
  options: { wrongUrl?: boolean; wrongTarget?: boolean; cancelOnOpen?: boolean } = {},
) {
  const controller = new AbortController();
  const requests: Array<{ path: string; body?: any; token?: string }> = [];
  const opened: string[] = [];
  let now = 1000;
  const input = {
    origin: "https://account.fixture.invalid",
    token: "native-private-root",
    hostId: "target",
    environmentId: "target-env",
    sourceHostId: "source",
    sourceDeviceCredential: "private-source-proof",
    signal: controller.signal,
  };
  const authorize = createAccountRemoteAuthorizer({
    now: () => now,
    sleep: async (ms) => {
      now += ms;
    },
    openExternal: async (url) => {
      opened.push(url);
      if (options.cancelOnOpen) controller.abort();
    },
    request: async (request) => {
      requests.push(request);
      expect(request.origin).toBe(input.origin);
      expect(request.token).toBe(input.token);
      if (request.path.endsWith("/start"))
        return {
          receipt: "r".repeat(43),
          authorizationUrl: `${options.wrongUrl ? "https://untrusted.fixture.invalid" : input.origin}/remote-access?request=${"p".repeat(43)}`,
          expiresAt: now + 60_000,
          pollIntervalMs: 1000,
        };
      if (request.path.endsWith("/cancel")) return { ok: true };
      if (requests.filter((item) => item.path.endsWith("/poll")).length === 1)
        return { status: "pending" };
      return {
        authorization: "a".repeat(43),
        hostId: options.wrongTarget ? "foreign" : input.hostId,
        environmentId: input.environmentId,
        sourceHostId: input.sourceHostId,
        expiresAt: now + 60_000,
      };
    },
  });
  return { authorize, input, requests, opened };
}

test("native Passkey authorization keeps PKCE/private receipts in main and verifies the selected source and target", async () => {
  const f = passkeyBrokerFixture();
  expect(await f.authorize(f.input)).toBe("a".repeat(43));
  expect(f.opened).toEqual([`${f.input.origin}/remote-access?request=${"p".repeat(43)}`]);
  const start = f.requests[0]!.body;
  const poll = f.requests.find((item) => item.path.endsWith("/poll"))!.body;
  expect(createHash("sha256").update(poll.codeVerifier).digest("base64url")).toBe(
    start.codeChallenge,
  );
  expect(start).toMatchObject({
    hostId: "target",
    environmentId: "target-env",
    sourceHostId: "source",
    sourceDeviceCredential: "private-source-proof",
  });
  for (const privateValue of [
    f.input.token,
    f.input.sourceDeviceCredential,
    poll.receipt,
    poll.codeVerifier,
  ])
    expect(f.opened.join("")).not.toContain(privateValue);
});

test.each([{ wrongUrl: true }, { wrongTarget: true }, { cancelOnOpen: true }])(
  "native Passkey authorization cancels rejected or abandoned private receipts: %j",
  async (options) => {
    const f = passkeyBrokerFixture(options);
    await expect(f.authorize(f.input)).rejects.toThrow();
    expect(f.requests.at(-1)!.path).toBe("/api/v1/account/remote-access/cancel");
    if (options.wrongUrl) expect(f.opened).toHaveLength(0);
    if (options.cancelOnOpen)
      expect(f.requests.some((item) => item.path.endsWith("/poll"))).toBe(false);
  },
);

for (const unreadable of [false, true]) {
  test(
    unreadable
      ? "cold first forget clears unreadable local registration without guessing remote authority"
      : "cold first forget loads and revokes the saved account device grant",
    async () => {
      const registration: RelayRegistration = {
        relayOrigin: "https://account.example",
        publicOrigin: "https://computer.devices.example",
        hostId: randomUUID(),
        environmentId: randomUUID(),
        accountId: randomUUID(),
        credential: token(),
        refreshToken: token(),
        credentialExpiresAt: Date.now() + 600_000,
        credentialEpoch: 1,
        protocolVersion: 1,
        name: "Computer",
      };
      let loads = 0;
      let deleted = false;
      let stops = 0;
      const requests: any[] = [];
      const controller = new MobileRemoteController({
        host: {
          status: () => undefined,
          stop: async () => {
            stops++;
          },
          onlineDeviceIds: () => [],
        } as any,
        tunnel: { stop: async () => {}, isRunning: () => false, isConnected: () => false } as any,
        binary: {} as any,
        passcode: { isSet: () => false } as any,
        store: {
          load: () => {
            loads++;
            if (unreadable) throw new Error("encrypted registration cannot be read");
            return registration;
          },
          forget: () => {
            deleted = true;
          },
        } as any,
        environmentDir: "/unused-for-forget",
        accountRequest: async (input) => {
          requests.push(input);
          return {};
        },
        changed: () => {},
      });
      expect(loads).toBe(0);
      await controller.forget();
      expect(loads).toBe(1);
      expect(deleted).toBe(true);
      expect(stops).toBe(1);
      expect(requests).toEqual(
        unreadable
          ? []
          : [
              {
                origin: registration.relayOrigin,
                path: "/api/v1/account/logout",
                token: registration.credential,
                body: {},
              },
            ],
      );
      for (let attempt = 0; attempt < 3; attempt++)
        expect(controller.relayStatus()).toEqual({ state: "unregistered", registered: false });
      expect(loads).toBe(1);
      await controller.dispose();
    },
  );
}

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

test("Desktop login binds automatically after network recovery but requires separate permission to accept remote access", async () => {
  const root = mkdtempSync(join(tmpdir(), "account-relay-auto-"));
  const identity = { origin: "https://account.example", accountId: randomUUID() };
  let saved: RelayRegistration | undefined;
  let active: any;
  let enrollments = 0;
  let starts = 0;
  let configured: any;
  let capabilityRequests = 0;
  const account: any = {
    status: () => ({
      state: "signed-in",
      origin: identity.origin,
      account: { id: identity.accountId },
    }),
    capabilities: async () => {
      if (++capabilityRequests === 1) throw new CloudAccountHttpError(503);
      return {
        relay: {
          enabled: true,
          directoryOrigin: identity.origin,
          protocolVersion: 1,
          accountHandoffVersion: 1,
        },
      };
    },
    getCredential: async () => token(),
  };
  const controller = new MobileRemoteController({
    host: {
      status: () => active,
      start: async (input) => {
        starts++;
        active = { mode: input.mode, url: "http://127.0.0.1:1234", port: 1234 };
        return active;
      },
      stop: async () => {
        active = undefined;
      },
      setAccountRelayAccess: (provider) => {
        configured = provider;
      },
      relayTarget: () => ({
        port: 1234,
        signal: new AbortController().signal,
        setPublicBaseUrl: () => {},
      }),
      onlineDeviceIds: () => [],
      createPairingUrl: () => ({
        url: "https://device.example/mobile",
        expiresAt: Date.now() + 30_000,
      }),
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
    environmentDir: root,
    autoRetryDelayMs: 5,
    account,
    accountRequest: async (input) => {
      expect(input.origin).toBe(identity.origin);
      expect(input.path).toBe("/api/v1/remote-hosts/ensure");
      enrollments++;
      return {
        ...(input.body as any),
        hostId: randomUUID(),
        accountId: identity.accountId,
        publicOrigin: "https://device.example",
        credential: token(),
        refreshToken: token(),
        credentialExpiresAt: Date.now() + 600_000,
        credentialEpoch: 1,
        protocolVersion: 1,
        remoteAccessEnabled: true, // An enrollment response cannot grant local consent.
      };
    },
    connectorFactory: (options) =>
      ({
        start: () => {
          options.onState?.("ready");
        },
        close: async () => {},
        state: () => "ready",
      }) as any,
    listProjects: async () => [
      { id: "actual-project", name: "My project", path: "/target/project" },
    ],
    changed: () => {},
  });
  try {
    expect(controller.relayStatus().state).toBe("unregistered");
    await expect(controller.activateAccountRelay(identity, () => true)).rejects.toThrow();
    const deadline = Date.now() + 2_000;
    while (!controller.relayStatus().registered) {
      if (Date.now() > deadline) throw new Error("Automatic first-login recovery did not occur");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await Promise.all([
      controller.activateAccountRelay(identity, () => true),
      controller.activateAccountRelay(identity, () => true),
    ]);
    expect(controller.relayStatus()).toMatchObject({
      state: "stopped",
      remoteAccessEnabled: false,
    });
    expect(enrollments).toBe(1);
    expect(starts).toBe(0);
    expect(configured).toBeUndefined();
    const binding = [saved!.hostId, saved!.environmentId, saved!.credentialEpoch];
    expect(
      await controller.accountRelaySource(identity, new AbortController().signal),
    ).toMatchObject({
      sourceHostId: saved!.hostId,
    });
    await controller.start({ mode: "relay" });
    expect(controller.relayStatus()).toMatchObject({ state: "ready", remoteAccessEnabled: true });
    expect(starts).toBe(1);
    expect(configured.hostId).toBe(saved!.hostId);
    expect(await configured.listProjects()).toEqual([
      { id: "actual-project", name: "My project", path: "/target/project" },
    ]);
    await controller.stop();
    await controller.activateAccountRelay(identity, () => true);
    expect(enrollments).toBe(1);
    expect(starts).toBe(1);
    expect(controller.relayStatus()).toMatchObject({
      state: "stopped",
      remoteAccessEnabled: false,
    });
    await controller.start({ mode: "relay" });
    expect(starts).toBe(2);
    expect([saved!.hostId, saved!.environmentId, saved!.credentialEpoch]).toEqual(binding);
    const publicState = JSON.stringify(controller.relayStatus());
    expect(publicState).not.toContain(saved!.credential);
    expect(publicState).not.toContain(saved!.refreshToken!);
    await controller.retireAccountRelay(identity);
    expect(configured).toBeUndefined();
    expect(active).toBeUndefined();
    expect(saved).toBeUndefined();
  } finally {
    await controller.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test("turning remote access off still stops and retires stale saved permission if secure storage fails", async () => {
  let saved: RelayRegistration | undefined = {
    relayOrigin: "https://account.example",
    publicOrigin: "https://device.example",
    hostId: randomUUID(),
    environmentId: randomUUID(),
    accountId: randomUUID(),
    name: "Computer",
    protocolVersion: 1,
    credentialEpoch: 1,
    credential: token(),
    refreshToken: token(),
    credentialExpiresAt: Date.now() + 600_000,
    remoteAccessEnabled: true,
  };
  let active = true;
  const retired: string[] = [];
  const controller = new MobileRemoteController({
    host: {
      status: () => (active ? { mode: "relay" } : undefined),
      stop: async () => {
        active = false;
      },
      onlineDeviceIds: () => [],
    } as any,
    tunnel: { stop: async () => {}, isRunning: () => false, isConnected: () => false } as any,
    binary: {} as any,
    passcode: {} as any,
    store: {
      load: () => saved,
      save: () => {
        throw new Error("keychain locked");
      },
      forget: () => {
        saved = undefined;
      },
    } as any,
    accountRequest: async (request) => {
      retired.push(request.path);
      return {};
    },
    environmentDir: "/unused",
    changed: () => {},
  });
  try {
    await expect(controller.stop()).rejects.toThrow("keychain locked");
    expect(active).toBe(false);
    expect(saved).toBeUndefined();
    expect(controller.relayStatus()).toMatchObject({ state: "storage-error", registered: false });
    expect(retired).toEqual(["/api/v1/account/logout"]);
  } finally {
    await controller.dispose();
  }
});

test("unsupported account relay reports upgrade without starting Host or consuming an enrollment", async () => {
  const identity = { origin: "https://account.example", accountId: randomUUID() };
  const controller = new MobileRemoteController({
    host: { status: () => undefined, stop: async () => {}, onlineDeviceIds: () => [] } as any,
    tunnel: { stop: async () => {}, isRunning: () => false, isConnected: () => false } as any,
    binary: {} as any,
    passcode: {} as any,
    store: { load: () => undefined } as any,
    environmentDir: "/unused-no-capability",
    account: {
      status: () => ({
        state: "signed-in",
        origin: identity.origin,
        account: { id: identity.accountId },
      }),
      capabilities: async () => ({}),
    } as any,
    changed: () => {},
  });
  try {
    await expect(controller.activateAccountRelay(identity, () => true)).rejects.toThrow();
    expect(controller.relayStatus()).toMatchObject({ state: "unavailable", registered: false });
    expect(controller.relayStatus().message).toContain("升级");
  } finally {
    await controller.dispose();
  }
});

test("account relay pairing is offered only to account registrations, follows sign-out and is rate limited", async () => {
  const origin = "https://account.example",
    accountId = randomUUID();
  const make = (account: boolean) => {
    const saved: RelayRegistration = {
      relayOrigin: origin,
      publicOrigin: "https://computer.devices.example",
      hostId: randomUUID(),
      environmentId: randomUUID(),
      name: "Computer",
      protocolVersion: 1,
      credentialEpoch: 1,
      credential: token(),
      ...(account
        ? { accountId, refreshToken: token(), credentialExpiresAt: Date.now() + 600_000 }
        : {}),
    };
    let current: any,
      signedIn = true,
      now = 1_000_000,
      pairings = 0;
    const connectors: any[] = [];
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
        createPairingUrl: () => {
          pairings++;
          const value = token();
          return { token: value, url: `https://x/mobile?pairing=${value}`, expiresAt: now + 1 };
        },
      } as any,
      tunnel: { stop: async () => {}, isRunning: () => false, isConnected: () => false } as any,
      binary: {} as any,
      passcode: { isSet: () => true } as any,
      store: { load: () => saved, save: () => {}, forget: () => {} } as any,
      account: {
        status: () =>
          signedIn
            ? { state: "signed-in", origin, account: { id: accountId, username: "alice" } }
            : { state: "signed-out" },
      } as any,
      accountRequest: async () => ({}),
      connectorFactory: (options) => {
        connectors.push(options);
        return {
          start: () => queueMicrotask(() => options.onState?.("ready")),
          close: async () => {},
        };
      },
      now: () => now,
      environmentDir: "/unused",
      changed: () => {},
    });
    return {
      controller,
      connectors,
      pairings: () => pairings,
      advance: (ms: number) => (now += ms),
      signOut: () => (signedIn = false),
    };
  };
  const legacy = make(false);
  await legacy.controller.start({ mode: "relay" });
  expect(legacy.connectors[0].issuePairing).toBeUndefined();
  await legacy.controller.dispose();

  const owned = make(true);
  await owned.controller.start({ mode: "relay" });
  // start() mints the Desktop's own QR pairing once.
  const baseline = owned.pairings();
  const issue = owned.connectors[0].issuePairing as () => { token: string };
  for (let i = 0; i < 6; i++) expect(issue().token).toHaveLength(43);
  expect(() => issue()).toThrow();
  owned.advance(60_000);
  expect(issue().token).toHaveLength(43);
  owned.signOut();
  expect(() => issue()).toThrow();
  expect(owned.pairings() - baseline).toBe(7);
  await owned.controller.dispose();
});

// ── Account computer dispatch (AccountDeviceService) ──
// Kept in this suite so the desktop test shard stays within its file budget.

class FixtureSocket extends EventEmitter {
  readyState = 1;
  sent: any[] = [];
  selectionReply = true;
  constructor(
    readonly hostId: string,
    readonly serial: number,
  ) {
    super();
    queueMicrotask(() => this.emit("open"));
  }
  send(bytes: string) {
    const event = JSON.parse(bytes);
    this.sent.push(event);
    if (event.type === "auth.device") queueMicrotask(() => this.message({ type: "auth.ok" }));
    if (event.type === "session.create")
      queueMicrotask(() =>
        this.message({
          type: "chat.accepted",
          projectId: event.projectId,
          sessionId: `${this.hostId}-session-${this.serial}`,
          clientRequestId: event.clientRequestId,
        }),
      );
    if (event.type === "session.select" && this.selectionReply)
      queueMicrotask(() => {
        this.message({ type: "permission.mode", sessionId: event.sessionId, mode: "default" });
        // Selection replays pending approvals immediately after its acknowledgment.
        this.message({
          method: "agent/approvalRequest",
          params: {
            sessionId: event.sessionId,
            requestId: "restored-approval",
            connectionId: "restored-worker",
            generation: 2,
            request: { toolName: "Write" },
          },
        });
      });
  }
  message(event: unknown) {
    this.emit("message", Buffer.from(JSON.stringify(event)));
  }
  close() {
    if (this.readyState !== 3) {
      this.readyState = 3;
      this.emit("close");
    }
  }
}
function fixture(options: { grantTtlMs?: number } = {}) {
  let identity: AccountDeviceIdentity | undefined = {
    origin: "https://account.fixture.invalid",
    accountId: "account-a",
  };
  const devices = ["a", "b"].map((id) => ({
    hostId: id,
    environmentId: `env-${id}`,
    name: `Computer ${id}`,
    online: true,
    revoked: false,
    protocolVersion: 1,
    publicOrigin: `https://${id}.computer.fixture.invalid`,
  }));
  const requests: Array<{ url: string; headers: Record<string, string>; body: any }> = [];
  const sockets: FixtureSocket[] = [];
  const events: Array<{ owner: number; event: AccountDeviceEvent }> = [];
  let foreignCapability = false;
  let foreignEnvironment = false;
  let grantTtlMs = options.grantTtlMs ?? 60_000;
  let selectionReply = true;
  let authorizations = 0;
  const service = new AccountDeviceService({
    authorizeTarget: async () => {
      authorizations++;
      return "passkey-once";
    },
    identity: () => identity,
    credential: async () => "account-bearer-do-not-forward",
    sourceProof: async () => ({
      sourceHostId: "source-host",
      sourceDeviceCredential: "source-device-secret",
    }),
    relayOrigin: async (account) =>
      foreignCapability ? "https://untrusted.fixture.invalid" : account.origin,
    fetch: (async (url: string, init: RequestInit) => {
      const parsed = new URL(url);
      const headers = init.headers as Record<string, string>;
      const body = init.body ? JSON.parse(String(init.body)) : undefined;
      requests.push({ url, headers, body });
      expect(init.redirect).toBe("error");
      expect(headers.Origin).toBe(parsed.origin);
      if (parsed.origin === "https://account.fixture.invalid") {
        expect(headers.Authorization).toBe("Bearer account-bearer-do-not-forward");
        if (parsed.pathname === "/api/v1/remote-hosts") return Response.json({ hosts: devices });
        const host = devices.find(
          (device) => parsed.pathname === `/api/v1/remote-hosts/${device.hostId}/handoffs`,
        );
        if (host) {
          expect(body).toEqual({
            environmentId: host.environmentId,
            sourceHostId: "source-host",
            sourceDeviceCredential: "source-device-secret",
            authorization: "passkey-once",
          });
          return Response.json({
            ...host,
            environmentId: foreignEnvironment ? "wrong" : host.environmentId,
            handoff: "handoff-once",
            relayAccessToken: "relay-grant",
            expiresAt: Date.now() + 30_000,
          });
        }
      }
      const host = devices.find((device) => device.publicOrigin === parsed.origin);
      if (!host) throw new Error(`Fixture blocked unexpected origin ${parsed.origin}`);
      expect(headers.Authorization).toBeUndefined();
      expect(JSON.stringify({ body, headers })).not.toContain("source-device-secret");
      expect(headers["X-CodeShell-Relay-Access"]).toBe("relay-grant");
      if (parsed.pathname === "/api/v1/relay/session") {
        expect(body).toEqual({ handoff: "handoff-once" });
        return Response.json({
          hostId: host.hostId,
          environmentId: host.environmentId,
          hostAccessToken: "host-grant",
          deviceId: `device-${sockets.length}`,
          secretHash: "device-secret",
          expiresAt: Date.now() + grantTtlMs,
        });
      }
      if (parsed.pathname === "/api/v1/relay/projects") {
        expect(headers["X-CodeShell-Host-Access"]).toBe("host-grant");
        return Response.json({
          hostId: host.hostId,
          environmentId: host.environmentId,
          projects: [
            { id: "shared-project-id", name: "Project", path: `/${host.hostId}/real-project` },
          ],
        });
      }
      throw new Error(`Fixture blocked unexpected path ${parsed.pathname}`);
    }) as typeof fetch,
    socket: (url, headers) => {
      const host = devices.find(
        (device) => new URL(url).origin === device.publicOrigin.replace("https:", "wss:"),
      );
      expect(host).toBeDefined();
      expect(headers.Authorization).toBeUndefined();
      expect(headers.Origin).toBe(host!.publicOrigin);
      const socket = new FixtureSocket(host!.hostId, sockets.length);
      socket.selectionReply = selectionReply;
      sockets.push(socket);
      return socket as any;
    },
  });
  service.setEventSink((owner, event) => events.push({ owner, event }));
  return {
    authorizations: () => authorizations,
    service,
    devices,
    sockets,
    requests,
    events,
    setGrantLifetime(value: number) {
      grantTtlMs = value;
    },
    withholdSelectionReply() {
      selectionReply = false;
    },
    switchIdentity() {
      identity = { origin: "https://account.fixture.invalid", accountId: "account-b" };
    },
    signOut() {
      identity = undefined;
      service.retireIdentity();
    },
    foreignCapability() {
      foreignCapability = true;
    },
    foreignEnvironment() {
      foreignEnvironment = true;
    },
  };
}

test("account devices bind tasks, output, approvals and Stop to the original Host/project/session", async () => {
  const f = fixture();
  try {
    expect(await f.service.list()).toHaveLength(2);
    const a = await f.service.connect(10, { hostId: "a", projectId: "shared-project-id" });
    const b = await f.service.connect(10, { hostId: "b", projectId: "shared-project-id" });
    expect(a.sessionId).not.toBe(b.sessionId);
    f.service.send(10, { connectionId: a.id, text: "Task on A" });
    f.service.send(10, { connectionId: b.id, text: "Task on B" });
    expect(f.sockets[0]!.sent.at(-1)).toMatchObject({
      type: "chat.send",
      sessionId: a.sessionId,
      text: "Task on A",
    });
    expect(f.sockets[1]!.sent.at(-1)).toMatchObject({ type: "chat.send", sessionId: b.sessionId });
    f.sockets[0]!.message({
      type: "session.stream",
      sessionId: b.sessionId,
      event: {
        method: "agent/streamEvent",
        params: { event: { type: "text_delta", text: "foreign" } },
      },
    });
    expect(f.events).toHaveLength(0);
    f.sockets[0]!.message({
      type: "session.stream",
      sessionId: a.sessionId,
      event: {
        method: "agent/streamEvent",
        params: { event: { type: "text_delta", text: "A output" } },
      },
    });
    expect(f.events[0]).toMatchObject({
      owner: 10,
      event: { hostId: "a", environmentId: "env-a", sessionId: a.sessionId, connectionId: a.id },
    });
    const approval = {
      method: "agent/approvalRequest",
      params: {
        sessionId: a.sessionId,
        requestId: "approval-a",
        connectionId: "worker-a",
        generation: 7,
        request: { toolName: "Write" },
      },
    };
    f.sockets[0]!.message(approval);
    expect(() =>
      f.service.approve(10, { connectionId: b.id, approvalId: "approval-a", approved: true }),
    ).toThrow("审批已过期");
    f.service.approve(10, {
      connectionId: a.id,
      approvalId: "approval-a",
      workerConnectionId: "worker-a",
      generation: 7,
      approved: false,
    });
    expect(f.sockets[0]!.sent.at(-1)).toMatchObject({
      type: "approval.respond",
      sessionId: a.sessionId,
      connectionId: "worker-a",
      generation: 7,
      decision: "reject",
    });
    // Another client kept the question open: the same route is republished.
    // The answer above was already sent, so a second one stays refused.
    f.sockets[0]!.message(approval);
    expect(() =>
      f.service.approve(10, {
        connectionId: a.id,
        approvalId: "approval-a",
        workerConnectionId: "worker-a",
        generation: 7,
        approved: true,
      }),
    ).toThrow("审批已过期");
    f.service.stop(10, { connectionId: a.id });
    expect(f.sockets[0]!.sent.at(-1)).toEqual({ type: "run.stop", sessionId: a.sessionId });
    expect(() => f.service.stop(99, { connectionId: a.id })).toThrow("授权已结束");
    f.sockets[0]!.close();
    const before = f.sockets[0]!.sent.length;
    expect(() => f.service.send(10, { connectionId: a.id, text: "No fallback" })).toThrow(
      "不会转到本机",
    );
    expect(f.sockets[0]!.sent).toHaveLength(before);
    expect(f.events.at(-1)?.event).toMatchObject({ type: "disconnected", connectionId: a.id });
    const publicBytes = JSON.stringify({ a, b, events: f.events, devices: await f.service.list() });
    for (const secret of [
      "account-bearer",
      "relay-grant",
      "host-grant",
      "device-secret",
      "source-device-secret",
    ])
      expect(publicBytes).not.toContain(secret);
  } finally {
    f.service.retireIdentity();
  }
});

test("late approval answers and resolutions cannot target a reused request from another worker generation", async () => {
  const f = fixture();
  try {
    const connection = await f.service.connect(1, { hostId: "a", projectId: "shared-project-id" });
    const socket = f.sockets[0]!;
    const request = (generation: number) =>
      socket.message({
        method: "agent/approvalRequest",
        params: {
          sessionId: connection.sessionId,
          requestId: "reused-id",
          connectionId: "worker-a",
          generation,
          request: { toolName: "Write" },
        },
      });
    const resolve = (generation: number) =>
      socket.message({
        method: "agent/approvalResolved",
        params: {
          sessionId: connection.sessionId,
          requestId: "reused-id",
          connectionId: "worker-a",
          generation,
        },
      });
    request(1);
    request(2);
    resolve(1);
    const before = socket.sent.length;
    expect(() =>
      f.service.approve(1, {
        connectionId: connection.id,
        approvalId: "reused-id",
        workerConnectionId: "worker-a",
        generation: 1,
        approved: true,
      }),
    ).toThrow("审批已过期");
    expect(socket.sent).toHaveLength(before);
    f.service.approve(1, {
      connectionId: connection.id,
      approvalId: "reused-id",
      workerConnectionId: "worker-a",
      generation: 2,
      approved: false,
    });
    expect(socket.sent.at(-1)).toMatchObject({ generation: 2, decision: "reject" });
    request(3);
    resolve(3);
    expect(() =>
      f.service.approve(1, {
        connectionId: connection.id,
        approvalId: "reused-id",
        workerConnectionId: "worker-a",
        generation: 3,
        approved: true,
      }),
    ).toThrow("审批已过期");
  } finally {
    f.service.retireIdentity();
  }
});

test("offline, revoked, unknown project and foreign capability fail closed before task dispatch", async () => {
  const f = fixture();
  f.devices[0]!.online = false;
  await expect(
    f.service.connect(1, { hostId: "a", projectId: "shared-project-id" }),
  ).rejects.toThrow("离线");
  expect(f.requests).toHaveLength(1);
  f.devices[0]!.online = true;
  f.devices[0]!.revoked = true;
  await expect(
    f.service.connect(1, { hostId: "a", projectId: "shared-project-id" }),
  ).rejects.toThrow("未获");
  f.devices[0]!.revoked = false;
  await expect(f.service.connect(1, { hostId: "a", projectId: "/local/path" })).rejects.toThrow(
    "实际项目",
  );
  expect(f.sockets).toHaveLength(0);
  const before = f.requests.length;
  f.foreignCapability();
  await expect(f.service.list()).rejects.toThrow("同源");
  expect(f.requests).toHaveLength(before);
});

test("handoff target mismatch never forwards a handoff to a computer", async () => {
  const f = fixture();
  f.foreignEnvironment();
  await expect(
    f.service.connect(1, { hostId: "a", projectId: "shared-project-id" }),
  ).rejects.toThrow("目标不匹配");
  expect(
    f.requests.every(
      (request) => new URL(request.url).origin === "https://account.fixture.invalid",
    ),
  ).toBe(true);
});

test("identity change immediately denies old handles; logout closes streams without sending a local Stop", async () => {
  const f = fixture();
  const connection = await f.service.connect(1, { hostId: "a", projectId: "shared-project-id" });
  f.switchIdentity();
  expect(() => f.service.send(1, { connectionId: connection.id, text: "other account" })).toThrow(
    "授权已结束",
  );
  f.signOut();
  expect(f.sockets[0]!.readyState).toBe(3);
  expect(f.sockets[0]!.sent.some((event) => event.type === "run.stop")).toBe(false);
  await expect(f.service.list()).rejects.toThrow("登录");
});

test("submission errors without sessionId are correlated; unknown admission and approval writes are never repeated", async () => {
  const f = fixture();
  try {
    const connection = await f.service.connect(1, { hostId: "a", projectId: "shared-project-id" });
    const socket = f.sockets[0]!;
    f.service.send(1, { connectionId: connection.id, text: "one intent" });
    const submission = socket.sent.at(-1);
    expect(() => f.service.send(1, { connectionId: connection.id, text: "blind retry" })).toThrow(
      "接收结果尚未确认",
    );
    socket.message({
      type: "error",
      clientMessageId: "another-client",
      message: "foreign failure",
    });
    expect(f.events).toHaveLength(0);
    socket.message({
      type: "error",
      clientMessageId: submission.clientMessageId,
      message: "Task admission rejected",
    });
    expect(f.events.at(-1)?.event.event).toMatchObject({
      type: "error",
      message: "Task admission rejected",
    });
    f.service.send(1, {
      connectionId: connection.id,
      text: "explicit new intent after known rejection",
    });
    expect(socket.sent.at(-1).clientMessageId).not.toBe(submission.clientMessageId);
    socket.message({
      method: "agent/approvalRequest",
      params: {
        sessionId: connection.sessionId,
        requestId: "one-approval",
        request: { toolName: "Write" },
      },
    });
    f.service.approve(1, {
      connectionId: connection.id,
      approvalId: "one-approval",
      approved: true,
    });
    const count = socket.sent.length;
    expect(() =>
      f.service.approve(1, {
        connectionId: connection.id,
        approvalId: "one-approval",
        approved: true,
      }),
    ).toThrow("审批已过期");
    expect(socket.sent).toHaveLength(count);
  } finally {
    f.service.retireIdentity();
  }
});

test("project discovery shares only its next connection's Passkey grant and owner teardown clears it", async () => {
  const f = fixture();
  try {
    await f.service.projects(1, { hostId: "a" });
    expect(f.authorizations()).toBe(1);
    await f.service.connect(1, { hostId: "a", projectId: "shared-project-id" });
    expect(f.authorizations()).toBe(1);
    await f.service.connect(1, { hostId: "a", projectId: "shared-project-id" });
    expect(f.authorizations()).toBe(2);
    await f.service.projects(2, { hostId: "a" });
    expect(f.authorizations()).toBe(3);
    f.service.releaseOwner(2);
    await f.service.connect(2, { hostId: "a", projectId: "shared-project-id" });
    expect(f.authorizations()).toBe(4);
  } finally {
    f.service.retireIdentity();
  }
});

test("owner teardown aborts an in-flight handoff and cannot leave an orphan execution socket", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started!: () => void;
  const start = new Promise<void>((resolve) => {
    started = resolve;
  });
  const service = new AccountDeviceService({
    authorizeTarget: async () => "passkey-once",
    identity: () => ({ origin: "https://account.fixture.invalid", accountId: "a" }),
    relayOrigin: async (identity) => identity.origin,
    sourceProof: async () => ({ sourceHostId: "source", sourceDeviceCredential: "source-secret" }),
    credential: async () => {
      started();
      await gate;
      return "never-forward";
    },
    fetch: async () => {
      throw new Error("must not fetch");
    },
  });
  const pending = service.connect(12, { hostId: "a", projectId: "p" });
  await start;
  service.releaseOwner(12);
  release();
  await expect(pending).rejects.toThrow("授权已结束");
});

test("expiry restores the same task binding and buffered approvals without replaying an unknown submission", async () => {
  const f = fixture({ grantTtlMs: 30 });
  try {
    const original = await f.service.connect(10, { hostId: "a", projectId: "shared-project-id" });
    f.service.send(10, { connectionId: original.id, text: "long task" });
    const oldSocket = f.sockets[0]!;
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(f.events.at(-1)?.event.type).toBe("disconnected");
    const beforeForeign = f.requests.length;
    await expect(f.service.resume(99, { connectionId: original.id })).rejects.toThrow("不属于");
    expect(f.requests).toHaveLength(beforeForeign);
    f.setGrantLifetime(60_000);
    const restored = await f.service.resume(10, { connectionId: original.id });
    expect(restored).toEqual({ ...original, historyNeedsReview: true });
    const socket = f.sockets[1]!;
    expect(socket.sent.map((event) => event.type)).toEqual(["auth.device", "session.select"]);
    expect(socket.sent[1]).toEqual({ type: "session.select", sessionId: original.sessionId });
    expect(
      f.sockets.flatMap((item) => item.sent).filter((event) => event.type === "chat.send"),
    ).toHaveLength(1);
    expect(f.events.at(-1)?.event.event?.method).toBe("agent/approvalRequest");
    const count = f.events.length;
    oldSocket.emit("close");
    oldSocket.message({
      type: "session.stream",
      sessionId: original.sessionId,
      event: { method: "late-old-stream" },
    });
    expect(f.events).toHaveLength(count);
    f.service.stop(10, { connectionId: restored.id });
    expect(socket.sent.at(-1)).toEqual({ type: "run.stop", sessionId: original.sessionId });
    f.service.approve(10, {
      connectionId: restored.id,
      approvalId: "restored-approval",
      workerConnectionId: "restored-worker",
      generation: 2,
      approved: false,
    });
    expect(socket.sent.at(-1)).toMatchObject({
      type: "approval.respond",
      sessionId: original.sessionId,
      generation: 2,
    });
    expect(() => f.service.send(10, { connectionId: restored.id, text: "blind resend" })).toThrow(
      "尚未确认",
    );
    expect(
      f.sockets.flatMap((item) => item.sent).filter((event) => event.type === "chat.send"),
    ).toHaveLength(1);
  } finally {
    f.service.retireIdentity();
  }
});

test("unexpected disconnect can resume, while explicit close and environment replacement cannot", async () => {
  const f = fixture();
  try {
    const original = await f.service.connect(1, { hostId: "a", projectId: "shared-project-id" });
    f.sockets[0]!.close();
    const [first, second] = await Promise.all([
      f.service.resume(1, { connectionId: original.id }),
      f.service.resume(1, { connectionId: original.id }),
    ]);
    expect(first).toEqual(second);
    expect(first.sessionId).toBe(original.sessionId);
    expect(f.sockets).toHaveLength(2);
    f.sockets[1]!.close();
    f.devices[0]!.environmentId = "replaced-env";
    await expect(f.service.resume(1, { connectionId: original.id })).rejects.toThrow("环境已更换");
    expect(f.sockets).toHaveLength(2);
    f.service.close(1, { connectionId: original.id });
    await expect(f.service.resume(1, { connectionId: original.id })).rejects.toThrow(
      "原电脑会话已失效",
    );
  } finally {
    f.service.retireIdentity();
  }
});

test("resume cannot succeed before its exact session selection acknowledgment or survive owner teardown", async () => {
  const f = fixture();
  try {
    const original = await f.service.connect(1, { hostId: "a", projectId: "shared-project-id" });
    f.withholdSelectionReply();
    let settled = false;
    const restoring = f.service.resume(1, { connectionId: original.id });
    void restoring.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await new Promise((resolve) => setImmediate(resolve));
    const socket = f.sockets[1]!;
    socket.message({ type: "permission.mode", sessionId: "foreign-session", mode: "default" });
    await new Promise((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    f.service.releaseOwner(1);
    await expect(restoring).rejects.toThrow("断线");
    expect(socket.readyState).toBe(3);
    expect(f.sockets.flatMap((item) => item.sent).some((event) => event.type === "chat.send")).toBe(
      false,
    );
  } finally {
    f.service.retireIdentity();
  }
});

test("oversized final frames fail before socket writes or admission tracking with delivery not-sent", async () => {
  const f = fixture();
  try {
    const connection = await f.service.connect(1, { hostId: "a", projectId: "shared-project-id" });
    const socket = f.sockets[0]!;
    const before = socket.sent.length;
    let failure: any;
    try {
      f.service.send(1, {
        connectionId: connection.id,
        text: "picture",
        attachments: [
          { transport: "inline", dataUrl: "data:image/png;base64," + "A".repeat(1_048_576) },
        ] as any,
      });
    } catch (error) {
      failure = error;
    }
    expect(failure?.delivery).toBe("not-sent");
    expect(failure?.message).toContain("1 MiB");
    expect(socket.sent).toHaveLength(before);
    f.service.send(1, { connectionId: connection.id, text: "small explicit task" });
    expect(socket.sent.at(-1)).toMatchObject({ type: "chat.send", text: "small explicit task" });
    expect(Buffer.byteLength(JSON.stringify(socket.sent.at(-1)))).toBeLessThanOrEqual(1_048_576);
  } finally {
    f.service.retireIdentity();
  }
});

test("transport write failures retain unknown delivery and prevent a repeated task", async () => {
  const f = fixture();
  try {
    const connection = await f.service.connect(1, { hostId: "a", projectId: "shared-project-id" });
    const socket = f.sockets[0]!;
    socket.send = () => {
      throw new Error("synthetic transport write failure");
    };
    let failure: any;
    try {
      f.service.send(1, { connectionId: connection.id, text: "one task" });
    } catch (error) {
      failure = error;
    }
    expect(failure?.delivery).toBe("unknown");
    let repeated: any;
    try {
      f.service.send(1, { connectionId: connection.id, text: "blind retry" });
    } catch (error) {
      repeated = error;
    }
    expect(repeated?.delivery).toBe("not-sent");
    expect(repeated?.message).toContain("尚未确认");
  } finally {
    f.service.retireIdentity();
  }
});
