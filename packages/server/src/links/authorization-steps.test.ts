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
