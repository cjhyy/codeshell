import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CredentialStore, PlaintextCipher, type Credential } from "@cjhyy/code-shell-core";
import { createLinkService } from "./service.js";
import type { HostLinkOAuthAdapter } from "./types.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});
const input = {
  providerId: "figma",
  methodId: "mcp",
  label: "My Figma MCP",
  expectedRevision: null,
};
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
function credential(id = "link-figma-mcp"): Credential {
  return {
    id,
    type: "oauth",
    label: input.label,
    secret: JSON.stringify({
      version: 1,
      accessToken: "fixture-access",
      refreshToken: "fixture-refresh",
      tokenType: "Bearer",
      expiresAt: "2099-01-01T00:00:00Z",
    }),
    meta: {
      linkProvider: "figma",
      linkConnectionMethod: "mcp",
      linkAuthSource: "mcp-oauth",
      linkExecutionBackend: "mcp",
      linkExecutionRuntime: "local",
      agentExposable: false,
      linkAccountId: "fixture@example.test",
      linkAccountLabel: "Fixture account",
      linkCapabilityIds: ["figma.get_metadata"],
      mcpServerUrl: "https://mcp.figma.com/mcp",
      resource: "https://mcp.figma.com/mcp",
      issuer: "https://api.figma.com",
    },
  };
}
function fixture(
  options: {
    authorizeUrl?: string;
    adapters?: boolean;
    cleanup?: Promise<void>;
    beforeUrl?: Promise<void>;
    onChanged?: () => void;
  } = {},
) {
  const directory = mkdtempSync(join(tmpdir(), "host-oauth-link-"));
  const store = new CredentialStore(undefined, new PlaintextCipher(), directory);
  const result = deferred<Credential>();
  let signal: AbortSignal | undefined;
  const opened: string[] = [];
  const disconnected: Credential[] = [];
  const adapter: HostLinkOAuthAdapter = {
    providerId: "figma",
    methodId: "mcp",
    authModeId: "mcp-oauth",
    label: "Connect MCP",
    async authorize(request) {
      signal = request.signal;
      await options.beforeUrl;
      await request.onAuthorizationUrl(
        options.authorizeUrl ?? "https://www.figma.com/oauth/mcp?state=fixture",
        new Date(Date.now() + 600_000).toISOString(),
      );
      return result.promise;
    },
    async openAuthorizationUrl(url) {
      opened.push(url);
    },
    async disconnect(value) {
      disconnected.push(value);
      await options.cleanup;
    },
  };
  const service = createLinkService({
    store,
    hostOAuthAdapters: options.adapters === false ? [] : [adapter],
    onChanged: options.onChanged,
  });
  cleanups.push(() => {
    service.close();
    result.resolve(credential());
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    service,
    store,
    result,
    opened,
    disconnected,
    context: { ownerId: "fixture-window", authorize: () => true },
    get signal() {
      return signal;
    },
  };
}
async function settle(f: ReturnType<typeof fixture>, id: string) {
  for (let i = 0; i < 100; i++) {
    const result = await f.service.authorization(f.context, id);
    if (result.state !== "pending") return result;
    await Promise.resolve();
  }
  throw new Error("Host OAuth did not settle");
}

test("Host OAuth appears in the unified provider and commits a masked MCP connection", async () => {
  const f = fixture();
  expect(
    f.service.snapshot().providers.find((provider) => provider.id === "figma")?.authModes,
  ).toContainEqual(expect.objectContaining({ id: "mcp-oauth", methodId: "mcp", available: true }));
  const job = await f.service.startAuthorization(f.context, input, "mcp-oauth");
  expect(job.step?.kind).toBe("redirect");
  expect(f.store.list()).toEqual([]);
  expect(await f.service.openHostAuthorization(f.context, job.id)).toBe(true);
  expect(f.opened).toHaveLength(1);
  f.result.resolve(credential());
  const completed = await settle(f, job.id);
  expect(completed.state).toBe("connected");
  expect(completed.connection).toMatchObject({
    id: "link-figma-mcp",
    methodId: "mcp",
    authSource: "mcp-oauth",
    runtime: "local",
    capabilityIds: ["figma.get_metadata"],
  });
  expect(JSON.stringify(completed)).not.toContain("fixture-access");
  expect(f.store.resolve("link-figma-mcp")?.type).toBe("oauth");
  expect(f.disconnected).toEqual([]);
});

test("native request cancellation stops discovery before an authorization URL exists", async () => {
  const beforeUrl = deferred<void>();
  const f = fixture({ beforeUrl: beforeUrl.promise });
  const abort = new AbortController();
  const starting = f.service.startAuthorization(
    { ...f.context, signal: abort.signal },
    input,
    "mcp-oauth",
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  abort.abort();
  const job = await starting;
  expect(job.state).toBe("cancelled");
  expect(f.signal?.aborted).toBe(true);
  expect(f.store.resolve("link-figma-mcp")).toBeUndefined();
  beforeUrl.resolve();
});

test("cancelled Host OAuth cannot adopt a late credential or reopen its browser", async () => {
  const f = fixture();
  const job = await f.service.startAuthorization(f.context, input, "mcp-oauth");
  await expect(
    f.service.openHostAuthorization({ ownerId: "other", authorize: () => true }, job.id),
  ).rejects.toThrow();
  await f.service.cancelAuthorization(f.context, job.id);
  expect(f.signal?.aborted).toBe(true);
  f.result.resolve(credential());
  expect((await settle(f, job.id)).state).toBe("cancelled");
  for (let i = 0; i < 100 && !f.disconnected.length; i++) await Promise.resolve();
  expect(f.disconnected).toEqual([credential()]);
  expect(f.store.list()).toEqual([]);
  await expect(f.service.openHostAuthorization(f.context, job.id)).rejects.toThrow();
});

test("a stale reconnect cannot overwrite a renamed connection", async () => {
  const f = fixture();
  f.store.save("user", credential());
  const prior = f.service.snapshot().connections[0]!;
  const job = await f.service.startAuthorization(
    f.context,
    { ...input, connectionId: prior.id, expectedRevision: prior.revision },
    "mcp-oauth",
  );
  f.store.save("user", { ...credential(), label: "Renamed while authorizing" });
  f.result.resolve({ ...credential(), secret: "candidate-that-must-not-win" });
  expect((await settle(f, job.id)).errorCode).toBe("conflict");
  expect(f.store.resolve(prior.id)?.label).toBe("Renamed while authorizing");
  for (let i = 0; i < 100 && !f.disconnected.length; i++) await Promise.resolve();
  expect(f.disconnected.map((value) => value.secret)).toEqual(["candidate-that-must-not-win"]);
});

test("notification failure after CAS never cleans up the committed candidate", async () => {
  const f = fixture({
    onChanged: () => {
      throw new Error("notification failed");
    },
  });
  const job = await f.service.startAuthorization(f.context, input, "mcp-oauth");
  f.result.resolve(credential());
  expect((await settle(f, job.id)).state).toBe("connected");
  expect(f.store.resolve("link-figma-mcp")?.secret).toBe(credential().secret);
  expect(f.disconnected).toEqual([]);
});

test("a rejected candidate sharing the old or current saved secret is never revoked", async () => {
  for (const shared of ["previous", "current"] as const) {
    const f = fixture();
    f.store.save("user", credential());
    const prior = f.service.snapshot().connections[0]!;
    const job = await f.service.startAuthorization(
      f.context,
      { ...input, connectionId: prior.id, expectedRevision: prior.revision },
      "mcp-oauth",
    );
    const current = { ...credential(), label: "Changed", secret: "new-saved-secret" };
    f.store.save("user", current);
    f.result.resolve(shared === "previous" ? credential() : current);
    expect((await settle(f, job.id)).errorCode).toBe("conflict");
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(f.disconnected).toEqual([]);
    expect(f.store.resolve(prior.id)).toEqual(current);
  }
});

test("disconnect removes only its exact connection before provider cleanup and preserves a later reconnect", async () => {
  const cleanup = deferred<void>();
  const f = fixture({ cleanup: cleanup.promise });
  f.store.save("user", credential());
  f.store.save("user", {
    id: "link-figma-pat",
    type: "link",
    label: "API",
    secret: "pat",
    meta: {
      linkProvider: "figma",
      linkExecutionRuntime: "local",
      linkExecutionBackend: "http-token",
    },
  });
  const prior = f.service
    .snapshot()
    .connections.find((connection) => connection.methodId === "mcp")!;
  const pending = f.service.disconnect(f.context, prior.id, prior.revision);
  for (let i = 0; i < 30 && f.store.resolve(prior.id); i++) await Promise.resolve();
  expect(f.store.resolve(prior.id)).toBeUndefined();
  expect(f.store.resolve("link-figma-pat")).toBeDefined();
  f.store.save("user", { ...credential(), label: "New connection" });
  cleanup.resolve();
  await pending;
  expect(f.store.resolve(prior.id)?.label).toBe("New connection");
});

test("an unavailable Host OAuth cannot be substituted with a manual token", async () => {
  const f = fixture({ adapters: false });
  await expect(f.service.startAuthorization(f.context, input, "mcp-oauth")).rejects.toThrow();
  await expect(
    f.service.connectToken(f.context, { ...input, token: "fixture-not-mcp" }),
  ).rejects.toThrow();
  expect(f.store.list()).toEqual([]);
});

test("insecure Host redirects fail before a browser can open or a credential can persist", async () => {
  const f = fixture({ authorizeUrl: "http://www.figma.com/oauth/mcp" });
  const job = await f.service.startAuthorization(f.context, input, "mcp-oauth");
  expect(job.state).toBe("failed");
  expect(f.opened).toEqual([]);
  expect(f.store.list()).toEqual([]);
});
