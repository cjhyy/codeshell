import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CredentialStore,
  PlaintextCipher,
  getCredentialAccess,
  setDefaultCredentialAccess,
  linkActionTool,
} from "@cjhyy/code-shell-core";
import { LinkDeviceOAuthBroker } from "./device-oauth.js";
import { createLinkService, type LinkService, type LinkServiceOptions } from "./service.js";
import type { LinkOperationContext } from "./types.js";

const directories: string[] = [];
const services: LinkService[] = [];
afterEach(() => {
  for (const service of services.splice(0)) service.close();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
const owner: LinkOperationContext = { ownerId: "device-one", authorize: () => true };
const other: LinkOperationContext = { ownerId: "device-two", authorize: () => true };
const input = {
  providerId: "github",
  methodId: "fine-grained-pat",
  label: "Fixture account",
  token: "synthetic-provider-secret",
  expectedRevision: null,
};
const validation = {
  providerId: "github",
  identity: {
    externalAccountId: "fixture-42",
    label: "fixture-user",
    resourceLabels: ["fixture/repository"],
  },
  capabilityIds: ["github.list_repos"],
  verifiedAt: "2026-09-08T00:00:00.000Z",
};

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function fixture(options: Partial<LinkServiceOptions> = {}) {
  const cwd = mkdtempSync(join(tmpdir(), "link-service-"));
  directories.push(cwd);
  const userDirectory = join(cwd, "user");
  const store = new CredentialStore(cwd, new PlaintextCipher(), userDirectory);
  const service = createLinkService({
    cwd,
    store,
    validateToken: async () => validation,
    ...options,
  });
  services.push(service);
  return { cwd, userDirectory, store, service };
}
function brokerFactory(options: { start?: Promise<void>; complete?: Promise<void> } = {}) {
  return () =>
    new LinkDeviceOAuthBroker({
      clientIds: { github: "public-fixture-client" },
      environment: {},
      sleep: async () => {
        await options.complete;
      },
      fetch: async (url) => {
        if (new Request(url).url.endsWith("/device/code")) {
          await options.start;
          return Response.json({
            device_code: "secret-device-code",
            user_code: "ABCD-EFGH",
            verification_uri: "https://github.com/login/device",
            expires_in: 600,
            interval: 1,
          });
        }
        return Response.json({
          access_token: "synthetic-oauth-access",
          refresh_token: "synthetic-oauth-refresh",
          token_type: "Bearer",
          expires_in: 7200,
        });
      },
    });
}
async function settled(service: LinkService, id: string, context = owner) {
  for (let i = 0; i < 100; i++) {
    const status = await service.authorization(context, id);
    if (status.state !== "pending") return status;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("fixture authorization did not settle");
}

describe("shared Link management", () => {
  test("catalog is shared, cloud methods remain unavailable and responses contain no secrets", async () => {
    const { service, store, userDirectory } = fixture();
    const connection = await service.connectToken(owner, input);
    const snapshot = service.snapshot();
    expect(snapshot.providers).toHaveLength(10);
    expect(
      snapshot.providers.every((provider) =>
        provider.connectionMethods
          .filter((method) => method.executionRuntime === "server")
          .every((method) => method.availability === "coming-soon"),
      ),
    ).toBe(true);
    expect(connection.account?.label).toBe("fixture-user");
    expect(connection.capabilityIds).toEqual(["github.list_repos"]);
    expect(JSON.stringify(snapshot)).not.toContain(input.token);
    expect(JSON.stringify(snapshot)).not.toContain("secretHint");
    expect(store.resolve(connection.id)?.meta?.agentExposable).toBe(false);
    expect(readFileSync(join(userDirectory, "credentials.json"), "utf8")).toContain(
      "plain:" + input.token,
    );
    expect(service.snapshot().revision).toBe(snapshot.revision);
  });
  test("create-only collision and stale rename/delete are rejected", async () => {
    const { service, store } = fixture();
    const original = await service.connectToken(owner, input);
    await expect(service.connectToken(other, input)).rejects.toMatchObject({
      status: 409,
      code: "conflict",
    });
    const renamed = await service.rename(owner, original.id, "Renamed", original.revision);
    expect(renamed.revision).not.toBe(original.revision);
    expect(store.resolve(original.id)?.secret).toBe(input.token);
    await expect(
      service.rename(owner, original.id, "Stale", original.revision),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(service.disconnect(owner, original.id, original.revision)).rejects.toMatchObject({
      code: "conflict",
    });
    await service.disconnect(owner, renamed.id, renamed.revision);
    expect(store.resolve(original.id)).toBeUndefined();
  });
  test("failed token verification does not replace the previous working connection", async () => {
    let reject = false;
    const { service, store } = fixture({
      validateToken: async () => {
        if (reject) throw new Error("Upstream reflected secret-do-not-return");
        return validation;
      },
    });
    const original = await service.connectToken(owner, input);
    reject = true;
    await expect(
      service.connectToken(owner, {
        ...input,
        token: "replacement-secret",
        connectionId: original.id,
        expectedRevision: original.revision,
      }),
    ).rejects.toMatchObject({ code: "provider_rejected" });
    expect(store.resolve(original.id)?.secret).toBe(input.token);
  });
  test("deletion by another instance during validation never resurrects the connection", async () => {
    const gate = deferred();
    let wait = false;
    const { service, store, userDirectory } = fixture({
      validateToken: async () => {
        if (wait) await gate.promise;
        return validation;
      },
    });
    const original = await service.connectToken(owner, input);
    wait = true;
    const updating = service.connectToken(owner, {
      ...input,
      token: "replacement",
      connectionId: original.id,
      expectedRevision: original.revision,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    new CredentialStore(undefined, new PlaintextCipher(), userDirectory).remove(
      "user",
      original.id,
    );
    gate.resolve();
    await expect(updating).rejects.toMatchObject({ code: "conflict" });
    expect(store.resolve(original.id)).toBeUndefined();
  });
  test("revocation aborts verification and cannot save after an ignored abort", async () => {
    const gate = deferred();
    let signal: AbortSignal | undefined;
    const { service, store } = fixture({
      validateToken: async (_provider, _token, options) => {
        signal = options?.signal;
        await gate.promise;
        return validation;
      },
    });
    const pending = service.connectToken(owner, input);
    await new Promise((resolve) => setTimeout(resolve, 0));
    service.cancelOwner(owner.ownerId);
    expect(signal?.aborted).toBe(true);
    gate.resolve();
    await expect(pending).rejects.toMatchObject({ code: "login_required" });
    expect(store.list()).toEqual([]);
  });
  test("reauthorizes inside the host mutation gate and after change notification", async () => {
    let authorized = true;
    const { service, store } = fixture({
      withMutation: async (write) => {
        authorized = false;
        return write();
      },
    });
    await expect(
      service.connectToken({ ...owner, authorize: () => authorized }, input),
    ).rejects.toMatchObject({ code: "login_required" });
    expect(store.list()).toEqual([]);
    const second = fixture({
      onChanged: () => {
        second.service.cancelOwner(owner.ownerId);
      },
    });
    await expect(second.service.connectToken(owner, input)).rejects.toMatchObject({
      code: "login_required",
    });
    expect(second.store.list()).toHaveLength(1);
  });
  test("disconnect bypasses the active-task mutation gate", async () => {
    let busy = false;
    let notifications = 0;
    const { service, store } = fixture({
      withMutation: async (write) => {
        if (busy) throw Object.assign(new Error("busy"), { status: 409 });
        return write();
      },
      onChanged: () => {
        notifications++;
      },
    });
    const connection = await service.connectToken(owner, input);
    busy = true;
    await service.disconnect(owner, connection.id, connection.revision);
    expect(store.list()).toEqual([]);
    expect(notifications).toBe(2);
  });
  test("project credentials are visible but cannot be overwritten from the user scope", async () => {
    const { service, store } = fixture();
    const connection = await service.connectToken(owner, input);
    store.save("project", store.resolve(connection.id)!);
    const current = service.snapshot().connections[0]!;
    expect(current.editable).toBe(false);
    await expect(service.disconnect(owner, current.id, current.revision)).rejects.toMatchObject({
      code: "read_only",
    });
  });
  test("binds only an already logged-in CLI and never returns the private binding marker", async () => {
    let login: boolean | undefined;
    const { service, store } = fixture({
      bindCli: async (_provider, options) => {
        login = options.loginIfNeeded;
        return validation;
      },
      cliStatus: async () => ({
        providerId: "github",
        command: "gh",
        installed: true,
        authenticated: true,
        account: "fixture-user",
        message: "raw-private-diagnostic",
      }),
    });
    const result = await service.connectCli(owner, input);
    expect(login).toBe(false);
    expect(result.authSource).toBe("cli-session");
    expect(store.resolve(result.id)?.secret).toStartWith("cli-binding:");
    expect(JSON.stringify(result)).not.toContain("cli-binding:");
    expect(JSON.stringify(await service.cliStatus(owner, "github"))).not.toContain(
      "raw-private-diagnostic",
    );
  });
  test("rejects arbitrary methods, identifiers and missing CAS instead of invoking a provider", async () => {
    let calls = 0;
    const { service } = fixture({
      validateToken: async () => {
        calls++;
        return validation;
      },
    });
    for (const bad of [
      { ...input, methodId: "managed-oauth" },
      { ...input, connectionId: "../../secret" },
      { ...input, expectedRevision: undefined },
    ])
      await expect(service.connectToken(owner, bad as typeof input)).rejects.toBeDefined();
    expect(calls).toBe(0);
  });
  test("unreadable credential file cannot be overwritten with an empty snapshot", async () => {
    const { service, userDirectory } = fixture();
    mkdirSync(userDirectory, { recursive: true });
    writeFileSync(join(userDirectory, "credentials.json"), "not-json");
    expect(() => service.snapshot()).toThrow("Link 服务暂时不可用");
    await expect(service.connectToken(owner, input)).rejects.toMatchObject({ code: "unavailable" });
    expect(readFileSync(join(userDirectory, "credentials.json"), "utf8")).toBe("not-json");
  });
});

describe("owner-bound Link device authorization", () => {
  test("expired browser OAuth is visible as expired even when it has refresh material", async () => {
    const { service, store } = fixture();
    const connection = await service.connectToken(owner, input);
    const credential = store.resolve(connection.id)!;
    store.save("user", {
      ...credential,
      meta: { ...credential.meta, linkAuthSource: "browser-oauth" },
      secret: JSON.stringify({
        version: 1,
        accessToken: "expired-access",
        refreshToken: "unused-refresh",
        expiresAt: "2000-01-01T00:00:00.000Z",
        tokenType: "Bearer",
        tokenEndpoint: "https://github.com/login/oauth/access_token",
        clientId: "fixture",
      }),
    });
    const current = service.snapshot().connections[0]!;
    expect(current.status).toBe("expired");
    expect(current.expiresAt).toBe("2000-01-01T00:00:00.000Z");
    expect(JSON.stringify(current)).not.toContain("expired-access");
    expect(JSON.stringify(current)).not.toContain("unused-refresh");
    const previous = getCredentialAccess();
    let secretResolutions = 0;
    setDefaultCredentialAccess({
      listMasked: () => store.listMasked(),
      resolveMeta: () => undefined,
      envExposures: () => ({}),
      resolveValue: async () => {
        secretResolutions++;
        throw new Error("expired token must never resolve");
      },
    });
    try {
      const result = JSON.parse(
        await linkActionTool({ provider: "github", action: "list_repositories", params: {} }),
      );
      expect(result.kind).toBe("error");
      expect(secretResolutions).toBe(0);
    } finally {
      setDefaultCredentialAccess(previous);
    }
  });
  test("finishes in the host and returns only masked connection state", async () => {
    const { service, store } = fixture({ createDeviceBroker: brokerFactory() });
    const attempt = await service.startDeviceAuth(owner, input);
    expect(attempt.prompt?.userCode).toBe("ABCD-EFGH");
    expect(JSON.stringify(attempt)).not.toContain("secret-device-code");
    const result = await settled(service, attempt.id);
    expect(result.state).toBe("connected");
    expect(JSON.stringify(result)).not.toContain("synthetic-oauth");
    expect(store.resolve(result.connection!.id)?.secret).toContain("synthetic-oauth-refresh");
  });
  test("other devices cannot read or cancel an authorization", async () => {
    const gate = deferred();
    const { service } = fixture({ createDeviceBroker: brokerFactory({ complete: gate.promise }) });
    const attempt = await service.startDeviceAuth(owner, input);
    await expect(service.authorization(other, attempt.id)).rejects.toMatchObject({ status: 404 });
    await expect(service.cancelAuthorization(other, attempt.id)).rejects.toMatchObject({
      status: 404,
    });
    await service.cancelAuthorization(owner, attempt.id);
    gate.resolve();
    expect((await service.authorization(owner, attempt.id)).state).toBe("cancelled");
  });
  test("same-provider authorizations belong to independent devices", async () => {
    const gate = deferred();
    const { service } = fixture({ createDeviceBroker: brokerFactory({ complete: gate.promise }) });
    const first = await service.startDeviceAuth(owner, input);
    const second = await service.startDeviceAuth(other, {
      ...input,
      connectionId: "other-account",
    });
    await service.cancelAuthorization(owner, first.id);
    expect((await service.authorization(other, second.id)).state).toBe("pending");
    gate.resolve();
    expect((await settled(service, second.id, other)).state).toBe("connected");
  });
  test("revocation during device-code creation cancels the late attempt without persisting", async () => {
    const gate = deferred();
    const { service, store } = fixture({
      createDeviceBroker: brokerFactory({ start: gate.promise }),
    });
    const pending = service.startDeviceAuth(owner, input);
    await new Promise((resolve) => setTimeout(resolve, 0));
    service.cancelOwner(owner.ownerId);
    gate.resolve();
    await expect(pending).rejects.toMatchObject({ code: "login_required" });
    expect(store.list()).toEqual([]);
  });
  test("cancel inside a delayed mutation gate prevents OAuth token persistence", async () => {
    const gate = deferred();
    let entered = false;
    const { service, store } = fixture({
      createDeviceBroker: brokerFactory(),
      withMutation: async (write) => {
        entered = true;
        await gate.promise;
        return write();
      },
    });
    const attempt = await service.startDeviceAuth(owner, input);
    for (let i = 0; !entered && i < 100; i++)
      await new Promise((resolve) => setTimeout(resolve, 1));
    expect(entered).toBe(true);
    await service.cancelAuthorization(owner, attempt.id);
    gate.resolve();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(store.list()).toEqual([]);
    expect((await service.authorization(owner, attempt.id)).state).toBe("cancelled");
  });
  test("a stale device authorization cannot overwrite a newly connected account", async () => {
    const gate = deferred();
    const { service, store } = fixture({
      createDeviceBroker: brokerFactory({ complete: gate.promise }),
    });
    const attempt = await service.startDeviceAuth(owner, input);
    const current = await service.connectToken(other, input);
    gate.resolve();
    expect((await settled(service, attempt.id)).errorCode).toBe("conflict");
    expect(store.resolve(current.id)?.secret).toBe(input.token);
  });
  test("close stops pending token validation even when its fake ignores cancellation", async () => {
    const gate = deferred();
    let validating = false;
    const { service, store } = fixture({
      createDeviceBroker: brokerFactory(),
      validateToken: async () => {
        validating = true;
        await gate.promise;
        return validation;
      },
    });
    await service.startDeviceAuth(owner, input);
    for (let i = 0; !validating && i < 100; i++)
      await new Promise((resolve) => setTimeout(resolve, 1));
    expect(validating).toBe(true);
    service.close();
    gate.resolve();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(store.list()).toEqual([]);
    await expect(service.connectToken(owner, input)).rejects.toMatchObject({ code: "unavailable" });
  });
});
