import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AccountRelayAccessGate, type AccountRelayBinding } from "./account-relay-access.js";
import { TrustedDeviceStore } from "./trusted-device-store.js";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

function fixture(redeem?: (handoff: string) => Promise<AccountRelayBinding>) {
  const root = mkdtempSync(join(tmpdir(), "account-relay-gate-"));
  roots.push(root);
  const path = join(root, "devices.json");
  const devices = new TrustedDeviceStore(path);
  const revoked: string[] = [];
  const gate = new AccountRelayAccessGate(devices, (id) => revoked.push(id));
  gate.setProvider({
    hostId: "host-a",
    environmentId: "env-a",
    accountId: "account-a",
    redeem:
      redeem ??
      (async () => ({
        authorizationId: "auth-a",
        accountId: "account-a",
        rootSessionId: "root-a",
        hostId: "host-a",
        environmentId: "env-a",
        leaseId: "lease-a",
        expiresAt: Date.now() + 60_000,
      })),
    listProjects: async () => [{ id: "p-a", name: "Actual project", path: "/actual/project" }],
  });
  const request = (token: string) =>
    ({ headers: { "x-codeshell-host-access": token } }) as IncomingMessage;
  return { gate, devices, revoked, path, request };
}

test("account handoff is single use and creates only an in-memory target-bound device", async () => {
  const f = fixture();
  try {
    const grant = await f.gate.exchange("single-use-handoff");
    expect(f.devices.authenticate(grant.deviceId, grant.secretHash)?.id).toBe(grant.deviceId);
    expect(existsSync(f.path)).toBe(false);
    expect(new TrustedDeviceStore(f.path).listDevices()).toEqual([]);
    await expect(f.gate.exchange("single-use-handoff")).rejects.toThrow(/unavailable/);
    const access = f.gate.capture(f.request(grant.hostAccessToken))!;
    expect(await f.gate.projects(access)).toEqual({
      hostId: "host-a",
      environmentId: "env-a",
      projects: [{ id: "p-a", name: "Actual project", path: "/actual/project" }],
    });
    expect(f.gate.capture(f.request("invalid"))).toBeUndefined();
    f.gate.setProvider(undefined);
    expect(access.isAuthorized()).toBe(false);
    expect(f.devices.authenticate(grant.deviceId, grant.secretHash)).toBeUndefined();
    expect(f.revoked).toEqual([grant.deviceId]);
  } finally {
    f.gate.clear();
  }
});

test.each(["hostId", "environmentId", "accountId"])(
  "account handoff rejects a mismatched %s",
  async (field) => {
    const f = fixture(async () => ({
      authorizationId: "auth-a",
      accountId: "account-a",
      rootSessionId: "root-a",
      hostId: "host-a",
      environmentId: "env-a",
      leaseId: "lease-a",
      expiresAt: Date.now() + 60_000,
      [field]: "foreign-target",
    }));
    await expect(f.gate.exchange("mismatched-target")).rejects.toThrow(/target/);
    expect(f.devices.listDevices()).toEqual([]);
  },
);

test("concurrent replay and a redemption resolving after stop cannot create authority", async () => {
  let resolve!: (binding: AccountRelayBinding) => void;
  let calls = 0;
  const f = fixture(() => {
    calls++;
    return new Promise((done) => (resolve = done));
  });
  const pending = f.gate.exchange("concurrent-handoff");
  await expect(f.gate.exchange("concurrent-handoff")).rejects.toThrow(/unavailable/);
  expect(calls).toBe(1);
  f.gate.clear();
  resolve({
    authorizationId: "auth-a",
    accountId: "account-a",
    rootSessionId: "root-a",
    hostId: "host-a",
    environmentId: "env-a",
    leaseId: "lease-a",
    expiresAt: Date.now() + 60_000,
  });
  await expect(pending).rejects.toThrow(/target/);
  expect(f.devices.listDevices()).toEqual([]);
});

test.each([
  { authorizationId: 123 },
  { rootSessionId: "" },
  { leaseId: "bad\0lease" },
  { leaseId: "x".repeat(513) },
  { expiresAt: 0 },
  { expiresAt: Number.MAX_SAFE_INTEGER },
])("malformed directory bindings fail closed: %j", async (invalid) => {
  const f = fixture(
    async () =>
      ({
        authorizationId: "auth-a",
        accountId: "account-a",
        rootSessionId: "root-a",
        hostId: "host-a",
        environmentId: "env-a",
        leaseId: "lease-a",
        expiresAt: Date.now() + 60_000,
        ...invalid,
      }) as AccountRelayBinding,
  );
  await expect(f.gate.exchange("malformed-binding")).rejects.toThrow(/target/);
  expect(f.devices.listDevices()).toEqual([]);
  expect(existsSync(f.path)).toBe(false);
});

test("expiry synchronously fences access and removes the ephemeral paired identity", async () => {
  const f = fixture(async () => ({
    authorizationId: "auth-a",
    accountId: "account-a",
    rootSessionId: "root-a",
    hostId: "host-a",
    environmentId: "env-a",
    leaseId: "lease-a",
    expiresAt: Date.now() + 30,
  }));
  const grant = await f.gate.exchange("expiring-handoff");
  const access = f.gate.capture(f.request(grant.hostAccessToken))!;
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(access.isAuthorized()).toBe(false);
  expect(f.gate.capture(f.request(grant.hostAccessToken))).toBeUndefined();
  expect(f.devices.authenticate(grant.deviceId, grant.secretHash)).toBeUndefined();
  expect(f.revoked).toEqual([grant.deviceId]);
});

test.each(["revoke", "remove"] as const)(
  "direct device %s invalidates the captured account grant and project reads",
  async (method) => {
    const f = fixture();
    try {
      const grant = await f.gate.exchange("removed-device-handoff");
      const access = f.gate.capture(f.request(grant.hostAccessToken))!;
      expect(f.devices[method](grant.deviceId)).toBe(true);
      expect(access.isAuthorized()).toBe(false);
      await expect(f.gate.projects(access)).rejects.toThrow(/expired/);
      expect(f.gate.capture(f.request(grant.hostAccessToken))).toBeUndefined();
      expect(f.revoked).toEqual([grant.deviceId]);
      expect(existsSync(f.path)).toBe(false);
    } finally {
      f.gate.clear();
    }
  },
);

test("retired redemption cannot release the new provider's pending replay guard", async () => {
  const completions: Array<(binding: AccountRelayBinding) => void> = [];
  const f = fixture(() => new Promise((done) => completions.push(done)));
  const binding = (): AccountRelayBinding => ({
    authorizationId: "auth-a",
    accountId: "account-a",
    rootSessionId: "root-a",
    hostId: "host-a",
    environmentId: "env-a",
    leaseId: "lease-a",
    expiresAt: Date.now() + 60_000,
  });
  const old = f.gate.exchange("overlapping-handoff");
  f.gate.clear();
  const current = f.gate.exchange("overlapping-handoff");
  completions[0]!(binding());
  await expect(old).rejects.toThrow(/target/);
  await expect(f.gate.exchange("overlapping-handoff")).rejects.toThrow(/unavailable/);
  expect(completions).toHaveLength(2);
  completions[1]!(binding());
  await current;
  f.gate.clear();
});
