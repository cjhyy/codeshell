import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CredentialStore,
  parseOAuthCredentialSecret,
  type EncryptionCipher,
  type OAuthTokens,
} from "@cjhyy/code-shell-core";
import { McpOAuthService, McpOAuthServiceError } from "./mcp-oauth-service.js";

class TestCipher implements EncryptionCipher {
  encrypt(plaintext: string): string {
    return `enc:test:${Buffer.from(plaintext).toString("base64")}`;
  }
  decrypt(stored: string): string {
    return Buffer.from(stored.slice("enc:test:".length), "base64").toString();
  }
  canDecrypt(stored: string): boolean {
    return stored.startsWith("enc:test:");
  }
}

describe("McpOAuthService", () => {
  let home: string;
  let previousHome: string | undefined;

  beforeEach(() => {
    previousHome = process.env.HOME;
    home = mkdtempSync(join(tmpdir(), "codeshell-oauth-"));
    process.env.HOME = home;
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  });

  function makeService(
    options: {
      authorizeTokens?: OAuthTokens;
      fetch?: typeof fetch;
      now?: () => number;
      changed?: () => void;
      revocationTimeoutMs?: number;
      authorizeError?: Error;
      logWarning?: (event: string, fields: Record<string, unknown>) => void;
    } = {},
  ) {
    const store = new CredentialStore(undefined, new TestCipher());
    const service = new McpOAuthService({
      store,
      openExternal: () => {},
      authorizeFn: async () => {
        if (options.authorizeError) throw options.authorizeError;
        return (
          options.authorizeTokens ?? {
            accessToken: "access-login",
            refreshToken: "refresh-login",
            expiresAt: Date.UTC(2030, 0, 1),
            tokenType: "Bearer",
          }
        );
      },
      fetch: options.fetch,
      now: options.now,
      onCredentialsChanged: options.changed,
      revocationTimeoutMs: options.revocationTimeoutMs,
      logWarning: options.logWarning,
    });
    return { service, store };
  }

  test("logs in through explicit PKCE metadata and atomically stores an encrypted secret", async () => {
    let changed = 0;
    const { service, store } = makeService({ changed: () => changed++ });
    const result = await service.login({
      source: "mcp",
      serverName: "Example MCP",
      serverUrl: "https://mcp.example/rpc",
      clientId: "client-id",
      authorizationEndpoint: "https://auth.example/authorize",
      tokenEndpoint: "https://auth.example/token",
      scopes: ["read", "write"],
    });

    expect(result.credential.id).toBe("example-mcp-oauth");
    expect(result.credential.hasSecret).toBe(true);
    expect((result.credential as { secret?: string }).secret).toBeUndefined();
    const stored = store.resolve("example-mcp-oauth")!;
    expect(parseOAuthCredentialSecret(stored.secret!)).toMatchObject({
      accessToken: "access-login",
      refreshToken: "refresh-login",
      clientId: "client-id",
      tokenEndpoint: "https://auth.example/token",
      resource: "https://mcp.example/rpc",
    });
    const diskPath = join(home, ".code-shell", "credentials.json");
    const disk = readFileSync(diskPath, "utf8");
    expect(disk).toContain("enc:test:");
    expect(disk).not.toContain("access-login");
    expect(disk).not.toContain("refresh-login");
    expect(statSync(diskPath).mode & 0o777).toBe(0o600);
    expect(changed).toBe(1);
  });

  test("singleflights refresh, rotates tokens and preserves an omitted refresh token", async () => {
    const now = Date.UTC(2026, 0, 1);
    let calls = 0;
    const { service, store } = makeService({
      authorizeTokens: {
        accessToken: "old-access",
        refreshToken: "old-refresh",
        expiresAt: now + 10_000,
        tokenType: "Bearer",
      },
      now: () => now,
      fetch: (async () => {
        calls++;
        await Promise.resolve();
        return Response.json({ access_token: "new-access", expires_in: 3600 });
      }) as typeof fetch,
    });
    await service.login({
      source: "mcp",
      serverName: "Example",
      serverUrl: "https://mcp.example/rpc",
      clientId: "client",
      authorizationEndpoint: "https://auth.example/authorize",
      tokenEndpoint: "https://auth.example/token",
    });

    const [first, second] = await Promise.all([
      service.resolveAccessToken("example-oauth"),
      service.resolveAccessToken("example-oauth"),
    ]);
    expect(first.accessToken).toBe("new-access");
    expect(second.accessToken).toBe("new-access");
    expect(calls).toBe(1);
    expect(parseOAuthCredentialSecret(store.resolve("example-oauth")!.secret!)).toMatchObject({
      accessToken: "new-access",
      refreshToken: "old-refresh",
      expiresAt: "2026-01-01T01:00:00.000Z",
    });
  });

  test("invalid_grant requires login but retains the credential for UI recovery", async () => {
    const now = Date.UTC(2026, 0, 1);
    const { service, store } = makeService({
      authorizeTokens: {
        accessToken: "old-access",
        refreshToken: "old-refresh",
        expiresAt: now - 1,
        tokenType: "Bearer",
      },
      now: () => now,
      fetch: (async () =>
        Response.json({ error: "invalid_grant" }, { status: 400 })) as typeof fetch,
    });
    await service.login({
      source: "mcp",
      serverName: "Example",
      serverUrl: "https://mcp.example/rpc",
      clientId: "client",
      authorizationEndpoint: "https://auth.example/authorize",
      tokenEndpoint: "https://auth.example/token",
    });

    await expect(service.refresh("example-oauth")).rejects.toThrow(/requires login/);
    expect(store.resolve("example-oauth")).toBeDefined();
    expect(store.resolve("example-oauth")?.meta?.lastRefreshErrorCode).toBe("invalid_grant");
  });

  test("proactive refresh may use a still-live token while a forced refresh fails closed", async () => {
    const now = Date.UTC(2026, 0, 1);
    const { service, store } = makeService({
      authorizeTokens: {
        accessToken: "still-live",
        refreshToken: "refresh",
        expiresAt: now + 30_000,
        tokenType: "Bearer",
      },
      now: () => now,
      fetch: (async () => {
        throw new Error("network unavailable");
      }) as typeof fetch,
    });
    await service.login({
      source: "mcp",
      serverName: "Example",
      serverUrl: "https://mcp.example/rpc",
      clientId: "client",
      authorizationEndpoint: "https://auth.example/authorize",
      tokenEndpoint: "https://auth.example/token",
    });

    await expect(service.resolveAccessToken("example-oauth")).resolves.toMatchObject({
      accessToken: "still-live",
    });
    await expect(
      service.resolveAccessToken("example-oauth", { forceRefresh: true }),
    ).rejects.toThrow(/refresh failed/);
  });

  test("removes the local credential even when remote revocation fails", async () => {
    const { service, store } = makeService({
      fetch: (async () => new Response("", { status: 503 })) as typeof fetch,
    });
    await service.login({
      source: "mcp",
      serverName: "Example",
      serverUrl: "https://mcp.example/rpc",
      clientId: "client",
      authorizationEndpoint: "https://auth.example/authorize",
      tokenEndpoint: "https://auth.example/token",
    });
    const cred = store.resolve("example-oauth")!;
    const secret = parseOAuthCredentialSecret(cred.secret!);
    store.save("user", {
      ...cred,
      secret: JSON.stringify({ ...secret, revocationEndpoint: "https://auth.example/revoke" }),
    });

    expect(await service.logout("example-oauth")).toEqual({ removed: true, remoteRevoked: false });
    expect(store.resolve("example-oauth")).toBeUndefined();
  });

  test("rejects insecure non-local endpoints before opening a browser", async () => {
    const { service, store } = makeService();
    await expect(
      service.login({
        source: "mcp",
        serverName: "Unsafe",
        serverUrl: "http://remote.example/rpc",
        clientId: "client",
        authorizationEndpoint: "https://auth.example/authorize",
        tokenEndpoint: "https://auth.example/token",
      }),
    ).rejects.toThrow(/MCP_OAUTH_INVALID_REQUEST/);
    expect(store.list()).toHaveLength(0);
  });

  test("refresh never forwards refresh/client secrets across an origin redirect", async () => {
    const now = Date.UTC(2026, 0, 1);
    const calls: Array<{ url: string; body: string }> = [];
    const { service, store } = makeService({
      authorizeTokens: {
        accessToken: "old-access",
        refreshToken: "sentinel-refresh",
        expiresAt: now - 1,
        tokenType: "Bearer",
      },
      now: () => now,
      fetch: (async (input: string | URL | Request, init?: RequestInit) => {
        const request = new Request(input, init);
        const body = await request.text();
        calls.push({ url: request.url, body });
        if (request.redirect !== "manual") {
          calls.push({ url: "https://attacker.example/collect", body });
          return Response.json({ access_token: "attacker-accepted-secret", expires_in: 3600 });
        }
        return new Response(null, {
          status: 307,
          headers: { Location: "https://attacker.example/collect" },
        });
      }) as typeof fetch,
    });
    await service.login({
      source: "mcp",
      serverName: "Example",
      serverUrl: "https://mcp.example/rpc",
      clientId: "client",
      authorizationEndpoint: "https://auth.example/authorize",
      tokenEndpoint: "https://auth.example/token",
    });
    const cred = store.resolve("example-oauth")!;
    const secret = parseOAuthCredentialSecret(cred.secret!);
    store.save("user", {
      ...cred,
      secret: JSON.stringify({ ...secret, clientSecret: "sentinel-client-secret" }),
    });

    await expect(service.refresh("example-oauth")).rejects.toThrow(/refresh failed/);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://auth.example/token");
    expect(calls.some((call) => call.url.includes("attacker.example"))).toBe(false);
  });

  test("revoke never forwards a token across an origin redirect", async () => {
    const calls: Array<{ url: string; body: string }> = [];
    const { service, store } = makeService({
      fetch: (async (input: string | URL | Request, init?: RequestInit) => {
        const request = new Request(input, init);
        const body = await request.text();
        calls.push({ url: request.url, body });
        if (request.redirect !== "manual") {
          calls.push({ url: "https://attacker.example/revoke", body });
          return new Response(null, { status: 200 });
        }
        return new Response(null, {
          status: 308,
          headers: { Location: "https://attacker.example/revoke" },
        });
      }) as typeof fetch,
    });
    await service.login({
      source: "mcp",
      serverName: "Example",
      serverUrl: "https://mcp.example/rpc",
      clientId: "client",
      authorizationEndpoint: "https://auth.example/authorize",
      tokenEndpoint: "https://auth.example/token",
    });
    const cred = store.resolve("example-oauth")!;
    const secret = parseOAuthCredentialSecret(cred.secret!);
    store.save("user", {
      ...cred,
      secret: JSON.stringify({
        ...secret,
        revocationEndpoint: "https://auth.example/revoke",
      }),
    });

    expect(await service.logout("example-oauth")).toEqual({
      removed: true,
      remoteRevoked: false,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://auth.example/revoke");
    expect(calls.some((call) => call.url.includes("attacker.example"))).toBe(false);
  });

  test("concurrent logout tombstones an in-flight refresh and the credential never revives", async () => {
    const now = Date.UTC(2026, 0, 1);
    let changed = 0;
    let refreshStarted!: () => void;
    const didStartRefresh = new Promise<void>((resolve) => {
      refreshStarted = resolve;
    });
    let finishRefresh!: (response: Response) => void;
    const deferredRefresh = new Promise<Response>((resolve) => {
      finishRefresh = resolve;
    });
    const { service, store } = makeService({
      authorizeTokens: {
        accessToken: "old-access",
        refreshToken: "old-refresh",
        expiresAt: now - 1,
        tokenType: "Bearer",
      },
      now: () => now,
      changed: () => changed++,
      fetch: (async () => {
        refreshStarted();
        return deferredRefresh;
      }) as typeof fetch,
    });
    await service.login({
      source: "mcp",
      serverName: "Example",
      serverUrl: "https://mcp.example/rpc",
      clientId: "client",
      authorizationEndpoint: "https://auth.example/authorize",
      tokenEndpoint: "https://auth.example/token",
    });

    const refreshing = service.refresh("example-oauth");
    await didStartRefresh;
    const loggingOut = service.logout("example-oauth");

    await expect(service.resolveAccessToken("example-oauth")).rejects.toThrow(/unavailable/);
    finishRefresh(Response.json({ access_token: "late-access", refresh_token: "late-refresh" }));

    await expect(refreshing).rejects.toThrow(/unavailable/);
    await expect(loggingOut).resolves.toEqual({ removed: true, remoteRevoked: true });
    expect(store.resolve("example-oauth")).toBeUndefined();
    expect(changed).toBe(2);
    await Promise.resolve();
    expect(store.resolve("example-oauth")).toBeUndefined();
  });

  test("revocation timeout cannot block local deletion or cache invalidation", async () => {
    let changed = 0;
    let revokeSignal: AbortSignal | undefined;
    const { service, store } = makeService({
      changed: () => changed++,
      revocationTimeoutMs: 20,
      fetch: (async (input: string | URL | Request, init?: RequestInit) => {
        const request = new Request(input, init);
        revokeSignal = request.signal;
        return new Promise<Response>(() => {});
      }) as typeof fetch,
    });
    await service.login({
      source: "mcp",
      serverName: "Example",
      serverUrl: "https://mcp.example/rpc",
      clientId: "client",
      authorizationEndpoint: "https://auth.example/authorize",
      tokenEndpoint: "https://auth.example/token",
    });
    const cred = store.resolve("example-oauth")!;
    const secret = parseOAuthCredentialSecret(cred.secret!);
    store.save("user", {
      ...cred,
      secret: JSON.stringify({ ...secret, revocationEndpoint: "https://auth.example/revoke" }),
    });

    const outcome = await Promise.race([
      service.logout("example-oauth"),
      new Promise<"test-timeout">((resolve) => setTimeout(() => resolve("test-timeout"), 200)),
    ]);

    expect(outcome).toEqual({ removed: true, remoteRevoked: false });
    expect(store.resolve("example-oauth")).toBeUndefined();
    expect(changed).toBe(2);
    expect(revokeSignal?.aborted).toBe(true);
    const disk = readFileSync(join(home, ".code-shell", "credentials.json"), "utf8");
    expect(disk).not.toContain("example-oauth");
    expect(disk).not.toContain("enc:test:");
  });

  test("normalizes explicit authorization errors without exposing provider details", async () => {
    const sentinel = "sentinel-provider-error-description";
    const logs: Array<{ event: string; fields: Record<string, unknown> }> = [];
    const { service, store } = makeService({
      authorizeError: new Error(`token endpoint rejected request: ${sentinel}`),
      logWarning: (event, fields) => logs.push({ event, fields }),
    });

    let failure: unknown;
    try {
      await service.login({
        source: "mcp",
        serverName: "Example",
        serverUrl: "https://mcp.example/rpc",
        clientId: "client",
        authorizationEndpoint: "https://auth.example/authorize",
        tokenEndpoint: "https://auth.example/token",
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(McpOAuthServiceError);
    expect((failure as McpOAuthServiceError).code).toBe("protocol_error");
    expect(String(failure)).toBe("McpOAuthServiceError: MCP_OAUTH_PROTOCOL_ERROR: OAuth failed");
    expect(String(failure)).not.toContain(sentinel);
    expect(JSON.stringify(logs)).not.toContain(sentinel);
    expect(logs).toEqual([
      {
        event: "mcp.oauth.failed",
        fields: { stage: "authorization", code: "protocol_error" },
      },
    ]);
    expect(store.list()).toEqual([]);
  });

  test("normalizes discovery response bodies before they reach renderer or logs", async () => {
    const sentinel = "sentinel-discovery-response-secret";
    const logs: Array<{ event: string; fields: Record<string, unknown> }> = [];
    const { service, store } = makeService({
      fetch: (async () =>
        Response.json(
          { error: "server_error", error_description: sentinel },
          { status: 503 },
        )) as typeof fetch,
      logWarning: (event, fields) => logs.push({ event, fields }),
    });

    let failure: unknown;
    try {
      await service.login({
        source: "mcp",
        serverName: "Discovery",
        serverUrl: "https://mcp.example/rpc",
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(McpOAuthServiceError);
    expect((failure as McpOAuthServiceError).code).toBe("server_error");
    expect(String(failure)).not.toContain(sentinel);
    expect(JSON.stringify(logs)).not.toContain(sentinel);
    expect(logs).toEqual([
      {
        event: "mcp.oauth.failed",
        fields: { stage: "discovery_registration", code: "server_error", status: 503 },
      },
    ]);
    expect(store.list()).toEqual([]);
  });
});
