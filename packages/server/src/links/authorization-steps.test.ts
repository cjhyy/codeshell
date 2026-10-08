import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CredentialStore, PlaintextCipher } from "@cjhyy/code-shell-core";
import { createLinkService, type LinkServiceOptions } from "./service.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});
const owner = { ownerId: "one", authorize: () => true };
const other = { ownerId: "two", authorize: () => true };
const input = {
  providerId: "github",
  methodId: "fine-grained-pat",
  label: "Account",
  expectedRevision: null,
};
const validation = {
  providerId: "github",
  identity: { externalAccountId: "42", label: "fixture" },
  capabilityIds: ["github.list_repos"],
  verifiedAt: "2026-10-08T00:00:00Z",
};
function fixture(options: Partial<LinkServiceOptions> = {}) {
  const directory = mkdtempSync(join(tmpdir(), "link-steps-"));
  const store = new CredentialStore(undefined, new PlaintextCipher(), directory);
  const service = createLinkService({ store, validateToken: async () => validation, ...options });
  cleanups.push(() => {
    service.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return { store, service };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
test("available authorization modes come from Host capabilities", () => {
  const { service } = fixture();
  const snapshot = service.snapshot();
  expect(snapshot.capabilities.authorizationSteps).toBe(1);
  const github = snapshot.providers.find((provider) => provider.id === "github")!;
  expect(github.authModes).toContainEqual(
    expect.objectContaining({ id: "token", available: true, methodId: input.methodId }),
  );
  expect(github.authModes?.find((mode) => mode.id === "browser-oauth")?.available).toBe(false);
  expect(github.authModes?.some((mode) => mode.kind === "qr-code")).toBe(false);
  expect(github.authModes?.some((mode) => mode.id === "remote-link")).toBe(false);
});
test("token begin/query are read-only; only current owner submission validates and saves", async () => {
  let calls = 0;
  const { service, store } = fixture({
    validateToken: async () => {
      calls++;
      return validation;
    },
  });
  const job = await service.startAuthorization(owner, input, "token");
  expect(job.step?.kind).toBe("credential-input");
  expect(job.methodId).toBe(input.methodId);
  expect(await service.authorization(owner, job.id)).toEqual(job);
  expect(await service.authorization(owner, job.id)).toEqual(job);
  expect(calls).toBe(0);
  await expect(service.authorization(other, job.id)).rejects.toMatchObject({ status: 404 });
  await expect(
    service.respondAuthorization(other, job.id, {
      stepId: job.step!.id,
      operation: "submit",
      input: { token: "private-token" },
    }),
  ).rejects.toMatchObject({ status: 404 });
  await expect(service.cancelAuthorization(other, job.id)).rejects.toMatchObject({ status: 404 });
  const done = await service.respondAuthorization(owner, job.id, {
    stepId: job.step!.id,
    operation: "submit",
    input: { token: "private-token" },
  });
  expect(done.state).toBe("connected");
  expect(done.connection?.account?.label).toBe("fixture");
  expect(done.step).toBeUndefined();
  expect(calls).toBe(1);
  expect(store.resolve(done.connection!.id)?.secret).toBe("private-token");
  expect(JSON.stringify(done)).not.toContain("private-token");
  await expect(
    service.respondAuthorization(owner, job.id, {
      stepId: job.step!.id,
      operation: "submit",
      input: { token: "private-token" },
    }),
  ).rejects.toMatchObject({ code: "conflict" });
});
test("rejected credentials permit retry with a new step, and old input cannot replay", async () => {
  let calls = 0;
  const { service } = fixture({
    validateToken: async () => {
      if (++calls === 1) throw new Error("private upstream detail");
      return validation;
    },
  });
  const job = await service.startAuthorization(owner, input, "token");
  const retry = await service.respondAuthorization(owner, job.id, {
    stepId: job.step!.id,
    operation: "submit",
    input: { token: "wrong" },
  });
  expect(retry.state).toBe("pending");
  expect(retry.errorCode).toBe("provider_rejected");
  expect(retry.step!.id).not.toBe(job.step!.id);
  expect(JSON.stringify(retry)).not.toContain("private upstream detail");
  await expect(
    service.respondAuthorization(owner, job.id, {
      stepId: job.step!.id,
      operation: "submit",
      input: { token: "correct" },
    }),
  ).rejects.toMatchObject({ code: "conflict" });
  const done = await service.respondAuthorization(owner, job.id, {
    stepId: retry.step!.id,
    operation: "submit",
    input: { token: "correct" },
  });
  expect(done.state).toBe("connected");
  expect(calls).toBe(2);
});
test("cancel aborts validation and a late success cannot persist", async () => {
  const gate = deferred<typeof validation>();
  let signal: AbortSignal | undefined;
  const { service, store } = fixture({
    validateToken: async (_provider, _token, options) => {
      signal = options?.signal;
      return gate.promise;
    },
  });
  const job = await service.startAuthorization(owner, input, "token");
  const pending = service.respondAuthorization(owner, job.id, {
    stepId: job.step!.id,
    operation: "submit",
    input: { token: "late" },
  });
  for (let i = 0; i < 30 && !signal; i++) await Promise.resolve();
  expect((await service.authorization(owner, job.id)).step?.kind).toBe("processing");
  await expect(
    service.respondAuthorization(owner, job.id, {
      stepId: job.step!.id,
      operation: "submit",
      input: { token: "duplicate" },
    }),
  ).rejects.toMatchObject({ code: "conflict" });
  await service.cancelAuthorization(owner, job.id);
  expect(signal?.aborted).toBe(true);
  gate.resolve(validation);
  expect((await pending).state).toBe("cancelled");
  expect((await service.authorization(owner, job.id)).state).toBe("cancelled");
  expect(store.list()).toEqual([]);
});
test("an expired input cannot validate or save", async () => {
  let clock = Date.now(),
    calls = 0;
  const { service, store } = fixture({
    now: () => clock,
    validateToken: async () => {
      calls++;
      return validation;
    },
  });
  const job = await service.startAuthorization(owner, input, "token");
  clock += 11 * 60_000;
  expect(await service.authorization(owner, job.id)).toMatchObject({
    state: "failed",
    errorCode: "authorization_expired",
  });
  await expect(
    service.respondAuthorization(owner, job.id, {
      stepId: job.step!.id,
      operation: "submit",
      input: { token: "late" },
    }),
  ).rejects.toMatchObject({ code: "conflict" });
  expect(calls).toBe(0);
  expect(store.list()).toEqual([]);
});
test("stale begin cannot overwrite a connection created by another window", async () => {
  const { service, store } = fixture();
  const job = await service.startAuthorization(owner, input, "token");
  const current = await service.connectToken(other, { ...input, token: "current" });
  const result = await service.respondAuthorization(owner, job.id, {
    stepId: job.step!.id,
    operation: "submit",
    input: { token: "stale" },
  });
  expect(result).toMatchObject({ state: "failed", errorCode: "conflict" });
  expect(store.resolve(current.id)?.secret).toBe("current");
});
test("fixed input fields and operations reject arbitrary commands and extra secrets", async () => {
  const { service } = fixture();
  const job = await service.startAuthorization(owner, input, "token");
  await expect(
    service.respondAuthorization(owner, job.id, {
      stepId: job.step!.id,
      operation: "submit",
      input: { token: "value", command: "untrusted" },
    }),
  ).rejects.toMatchObject({ code: "invalid_request" });
  await expect(
    service.respondAuthorization(owner, job.id, {
      stepId: job.step!.id,
      operation: "confirm",
      input: {},
    }),
  ).rejects.toMatchObject({ code: "invalid_request" });
  await expect(service.startAuthorization(owner, input, "qr-code")).rejects.toMatchObject({
    code: "invalid_request",
  });
});
test("CLI login is native-only and still requires explicit binding after login", async () => {
  const logged: boolean[] = [];
  const status = async () => ({
    providerId: "github" as const,
    command: "gh",
    installed: true,
    authenticated: false,
  });
  const remote = fixture({ cliStatus: status });
  const denied = await remote.service.startAuthorization(owner, input, "cli-session");
  expect(denied.step?.kind === "local-session" && denied.step.session.canLogin).toBe(false);
  await expect(
    remote.service.respondAuthorization(owner, denied.id, {
      stepId: denied.step!.id,
      operation: "login-session",
    }),
  ).rejects.toMatchObject({ code: "invalid_request" });
  const native = fixture({
    allowCliLogin: true,
    cliStatus: status,
    bindCli: async (_provider, options) => {
      logged.push(options.loginIfNeeded);
      return validation;
    },
  });
  const job = await native.service.startAuthorization(owner, input, "cli-session");
  const ready = await native.service.respondAuthorization(owner, job.id, {
    stepId: job.step!.id,
    operation: "login-session",
  });
  expect(ready.state).toBe("pending");
  expect(ready.step?.kind === "local-session" && ready.step.session.account).toBe("fixture");
  expect(native.store.list()).toEqual([]);
  const done = await native.service.respondAuthorization(owner, job.id, {
    stepId: ready.step!.id,
    operation: "bind-session",
  });
  expect(done.state).toBe("connected");
  expect(logged).toEqual([true, false]);
  expect(native.store.resolve(done.connection!.id)?.secret?.startsWith("cli-binding:")).toBe(true);
});
test("remote capability discovery suppresses unconfigured providers without changing local methods", async () => {
  const { service } = fixture({
    remoteLink: () => ({
      issuer: "https://link.example",
      clientId: "client",
      redirectUri: "http://127.0.0.1/link/callback",
    }),
    readRemoteCatalog: async () => [],
  });
  await service.refreshRemoteCatalog(owner);
  expect(service.snapshot().capabilities.remoteAuth).toBe(false);
  expect(
    service
      .snapshot()
      .providers.find((provider) => provider.id === "github")
      ?.authModes?.some((mode) => mode.id === "token" && mode.available),
  ).toBe(true);
  await expect(
    service.startAuthorization(owner, { ...input, methodId: "remote-link" }, "remote-link"),
  ).rejects.toMatchObject({ code: "invalid_request" });
});

test("CLI confirmation uses the verified stable identity and rotates when the account changes", async () => {
  const calls: boolean[] = [];
  let account = validation;
  const { service, store } = fixture({
    cliStatus: async () => ({
      providerId: "github",
      command: "gh",
      installed: true,
      authenticated: true,
      account: "stale label",
    }),
    bindCli: async (_provider, options) => {
      calls.push(options.loginIfNeeded);
      return account;
    },
  });
  const job = await service.startAuthorization(owner, input, "cli-session");
  expect(job.step?.kind === "local-session" && job.step.session.account).toBe("fixture");
  // Labels can be identical for different accounts; only the stable ID is authoritative.
  account = {
    ...validation,
    identity: { ...validation.identity, externalAccountId: "different-account" },
  };
  const changed = await service.respondAuthorization(owner, job.id, {
    stepId: job.step!.id,
    operation: "bind-session",
  });
  expect(changed.state).toBe("pending");
  expect(changed.step?.kind === "local-session" && changed.step.session.message).toContain("确认");
  expect(changed.step!.id).not.toBe(job.step!.id);
  expect(store.list()).toEqual([]);
  await expect(
    service.respondAuthorization(owner, job.id, {
      stepId: job.step!.id,
      operation: "bind-session",
    }),
  ).rejects.toMatchObject({ code: "conflict" });
  const done = await service.respondAuthorization(owner, job.id, {
    stepId: changed.step!.id,
    operation: "bind-session",
  });
  expect(done.state).toBe("connected");
  expect(done.connection?.account?.id).toBe("different-account");
  expect(calls).toEqual([false, false, false]);
});

test("CLI detection verifies identity again and unauthenticated steps cannot bind", async () => {
  let authenticated = false;
  let calls = 0;
  const { service, store } = fixture({
    cliStatus: async () => ({
      providerId: "github",
      command: "gh",
      installed: true,
      authenticated,
      account: "unverified",
    }),
    bindCli: async () => {
      calls++;
      return validation;
    },
  });
  const job = await service.startAuthorization(owner, input, "cli-session");
  await expect(
    service.respondAuthorization(owner, job.id, {
      stepId: job.step!.id,
      operation: "bind-session",
    }),
  ).rejects.toMatchObject({ code: "invalid_request" });
  expect(calls).toBe(0);
  authenticated = true;
  const detected = await service.respondAuthorization(owner, job.id, {
    stepId: job.step!.id,
    operation: "detect-session",
  });
  expect(detected.step?.kind === "local-session" && detected.step.session.account).toBe("fixture");
  expect(calls).toBe(1);
  expect(store.list()).toEqual([]);
});

test("CLI installation permission is native-only and does not imply an installed session", async () => {
  const status = async () => ({
    providerId: "github" as const,
    command: "gh",
    installed: false,
    authenticated: false,
  });
  for (const allowCliLogin of [false, true]) {
    const { service } = fixture({ cliStatus: status, allowCliLogin });
    const job = await service.startAuthorization(owner, input, "cli-session");
    expect(job.step?.kind === "local-session" && job.step.session.canInstall).toBe(allowCliLogin);
    expect(job.step?.kind === "local-session" && job.step.session.canLogin).toBe(false);
  }
});

test("remote authorization is ordered first while local method preference stays intact", async () => {
  const { service } = fixture({
    readRemoteCatalog: async () => ["github"],
    remoteLink: () => ({
      issuer: "https://link.example",
      clientId: "client",
      redirectUri: "http://127.0.0.1/link/callback",
    }),
  });
  expect(
    service
      .snapshot()
      .providers.find((provider) => provider.id === "github")!
      .authModes!.some((mode) => mode.id === "remote-link"),
  ).toBe(false);
  await service.refreshRemoteCatalog(owner);
  const modes = service
    .snapshot()
    .providers.find((provider) => provider.id === "github")!.authModes!;
  expect(modes[0]).toMatchObject({ id: "remote-link", preferred: true });
  expect(modes.find((mode) => mode.id === "token")).toMatchObject({ preferred: true });
});

for (const boundary of ["validation", "mutation"] as const) {
  test(`interactive deadline after ${boundary} await fails without persisting`, async () => {
    let clock = Date.now();
    const entered = deferred<void>();
    const gate = deferred<void>();
    const { service, store } = fixture({
      now: () => clock,
      validateToken: async () => {
        if (boundary === "validation") {
          entered.resolve();
          await gate.promise;
        }
        return validation;
      },
      withMutation: async (write) => {
        if (boundary === "mutation") {
          entered.resolve();
          await gate.promise;
        }
        return write();
      },
    });
    const job = await service.startAuthorization(owner, input, "token");
    const pending = service.respondAuthorization(owner, job.id, {
      stepId: job.step!.id,
      operation: "submit",
      input: { token: "late" },
    });
    await entered.promise;
    clock = Date.parse(job.expiresAt!) + 1;
    gate.resolve();
    expect(await pending).toMatchObject({ state: "failed", errorCode: "authorization_expired" });
    expect(store.list()).toEqual([]);
  });
}

test("interactive cancellation before the mutation write never persists", async () => {
  const entered = deferred<void>();
  const gate = deferred<void>();
  const { service, store } = fixture({
    withMutation: async (write) => {
      entered.resolve();
      await gate.promise;
      return write();
    },
  });
  const job = await service.startAuthorization(owner, input, "token");
  const pending = service.respondAuthorization(owner, job.id, {
    stepId: job.step!.id,
    operation: "submit",
    input: { token: "cancelled" },
  });
  await entered.promise;
  await service.cancelAuthorization(owner, job.id);
  gate.resolve();
  expect(await pending).toMatchObject({ state: "cancelled", errorCode: "cancelled" });
  expect(store.list()).toEqual([]);
});

for (const interruption of ["cancel", "expiry", "notification-error"] as const) {
  test(`interactive save stays connected when ${interruption} occurs during notification`, async () => {
    let clock = Date.now();
    const entered = deferred<void>();
    const gate = deferred<void>();
    const { service, store } = fixture({
      now: () => clock,
      onChanged: async () => {
        entered.resolve();
        await gate.promise;
        if (interruption === "notification-error") throw new Error("notification failed");
      },
    });
    const job = await service.startAuthorization(owner, input, "token");
    clock = Date.parse(job.expiresAt!) - 1_000;
    const pending = service.respondAuthorization(owner, job.id, {
      stepId: job.step!.id,
      operation: "submit",
      input: { token: "saved" },
    });
    await entered.promise;
    expect(store.list()).toHaveLength(1);
    if (interruption === "cancel") await service.cancelAuthorization(owner, job.id);
    else clock += 2_000;
    expect(await service.authorization(owner, job.id)).toMatchObject({ state: "connected" });
    gate.resolve();
    const done = await pending;
    expect(done.state).toBe("connected");
    expect(store.resolve(done.connection!.id)?.secret).toBe("saved");
  });
}

test("concurrent remote starts recheck pending capacity after catalog discovery", async () => {
  const catalog = deferred<Array<"github">>();
  const { service } = fixture({
    remoteLink: () => ({
      issuer: "https://link.example",
      clientId: "fixture",
      redirectUri: "http://localhost:4900/callback",
    }),
    readRemoteCatalog: () => catalog.promise,
  });
  const starts = Array.from({ length: 3 }, (_, index) =>
    service.startRemoteAuth(owner, {
      ...input,
      methodId: "remote-link",
      connectionId: `concurrent-${index}`,
    }),
  );
  catalog.resolve(["github"]);
  const result = await Promise.allSettled(starts);
  expect(result.filter((item) => item.status === "fulfilled")).toHaveLength(2);
  expect(result.find((item) => item.status === "rejected")).toMatchObject({
    reason: { code: "busy" },
  });
});
