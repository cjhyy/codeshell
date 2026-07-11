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
import type { McpOAuthProfile } from "./mcp-oauth-profiles.js";

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
      authorizeTokens?:
        | OAuthTokens
        | Promise<OAuthTokens>
        | (() => OAuthTokens | Promise<OAuthTokens>);
      fetch?: typeof fetch;
      now?: () => number;
      changed?: () => void;
      revocationTimeoutMs?: number;
      authorizeError?: Error;
      logWarning?: (event: string, fields: Record<string, unknown>) => void;
      profiles?: Readonly<Record<string, McpOAuthProfile>>;
      onAuthorizeConfig?: (config: {
        clientId: string;
        clientSecret?: string;
        authorizationEndpoint: string;
        tokenEndpoint: string;
        scopes?: string[];
      }) => void;
    } = {},
  ) {
    const store = new CredentialStore(undefined, new TestCipher());
    const service = new McpOAuthService({
      store,
      openExternal: () => {},
      authorizeFn: async (config) => {
        options.onAuthorizeConfig?.(config);
        if (options.authorizeError) throw options.authorizeError;
        const supplied = options.authorizeTokens;
        return (
          (typeof supplied === "function" ? await supplied() : await supplied) ?? {
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
      profiles: options.profiles,
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

  test("concurrent logout tombstones a deferred explicit relogin and late tokens never revive it", async () => {
    let changed = 0;
    let authorizeStarted!: () => void;
    const didStartAuthorize = new Promise<void>((resolve) => {
      authorizeStarted = resolve;
    });
    let finishAuthorize!: (tokens: OAuthTokens) => void;
    const deferredAuthorize = new Promise<OAuthTokens>((resolve) => {
      finishAuthorize = resolve;
    });
    const { service, store } = makeService({
      changed: () => changed++,
      authorizeTokens: deferredAuthorize,
      onAuthorizeConfig: () => authorizeStarted(),
    });
    store.save("user", {
      id: "example-oauth",
      type: "oauth",
      label: "Example OAuth",
      secret: JSON.stringify({
        version: 1,
        accessToken: "old-access",
        refreshToken: "old-refresh",
        clientId: "client",
        tokenEndpoint: "https://auth.example/token",
      }),
      meta: {
        mcpServerName: "Example",
        mcpServerUrl: "https://mcp.example/rpc",
        authUrl: "https://auth.example/authorize",
        tokenEndpoint: "https://auth.example/token",
        clientId: "client",
      },
    });

    const relogin = service.login({
      source: "mcp",
      serverName: "Example",
      serverUrl: "https://mcp.example/rpc",
      credentialId: "example-oauth",
      clientId: "client",
      authorizationEndpoint: "https://auth.example/authorize",
      tokenEndpoint: "https://auth.example/token",
    });
    await didStartAuthorize;
    const loggingOut = service.logout("example-oauth");
    await expect(loggingOut).resolves.toEqual({ removed: true, remoteRevoked: true });
    expect(store.resolve("example-oauth")).toBeUndefined();
    expect(changed).toBe(1);

    finishAuthorize({
      accessToken: "late-access",
      refreshToken: "late-refresh",
      expiresAt: Date.UTC(2030, 0, 1),
      tokenType: "Bearer",
    });
    await expect(relogin).rejects.toThrow();

    expect(store.resolve("example-oauth")).toBeUndefined();
    expect(changed).toBe(1);
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

  test("relogin reuses same-server explicit metadata after invalid_grant without discovery", async () => {
    const now = Date.UTC(2026, 0, 1);
    const authorizeConfigs: Array<{
      clientId: string;
      clientSecret?: string;
      authorizationEndpoint: string;
      tokenEndpoint: string;
      scopes?: string[];
    }> = [];
    let authorizeCount = 0;
    let discoveryOrRefreshCalls = 0;
    const store = new CredentialStore(undefined, new TestCipher());
    const service = new McpOAuthService({
      store,
      now: () => now,
      openExternal: () => {},
      authorizeFn: async (config) => {
        authorizeConfigs.push(config);
        authorizeCount++;
        return {
          accessToken: `access-${authorizeCount}`,
          refreshToken: `refresh-${authorizeCount}`,
          expiresAt: now - 1,
          tokenType: "Bearer",
        };
      },
      fetch: (async () => {
        discoveryOrRefreshCalls++;
        return Response.json({ error: "invalid_grant" }, { status: 400 });
      }) as typeof fetch,
      logWarning: () => {},
    });
    await service.login({
      source: "mcp",
      serverName: "Explicit Only",
      serverUrl: "https://mcp.example/rpc",
      clientId: "registered-client",
      authorizationEndpoint: "https://auth.example/authorize",
      tokenEndpoint: "https://auth.example/token",
      scopes: ["read", "write"],
    });
    const first = store.resolve("explicit-only-oauth")!;
    const firstSecret = parseOAuthCredentialSecret(first.secret!);
    store.save("user", {
      ...first,
      secret: JSON.stringify({
        ...firstSecret,
        clientSecret: "stored-private-client-secret",
        clientRegistration: {
          clientId: "registered-client",
          clientSecret: "stored-private-client-secret",
        },
      }),
    });

    await expect(service.refresh("explicit-only-oauth")).rejects.toThrow(/requires login/);
    expect(store.resolve("explicit-only-oauth")?.meta?.lastRefreshErrorCode).toBe("invalid_grant");

    await expect(
      service.login({
        source: "mcp",
        serverName: "Explicit Only",
        serverUrl: "https://mcp.example/rpc",
        credentialId: "explicit-only-oauth",
      }),
    ).resolves.toMatchObject({ credential: { id: "explicit-only-oauth" } });

    expect(discoveryOrRefreshCalls).toBe(1);
    expect(authorizeConfigs).toEqual([
      {
        clientId: "registered-client",
        clientSecret: undefined,
        authorizationEndpoint: "https://auth.example/authorize",
        tokenEndpoint: "https://auth.example/token",
        scopes: ["read", "write"],
        resource: "https://mcp.example/rpc",
      },
      {
        clientId: "registered-client",
        clientSecret: "stored-private-client-secret",
        authorizationEndpoint: "https://auth.example/authorize",
        tokenEndpoint: "https://auth.example/token",
        scopes: ["read", "write"],
        resource: "https://mcp.example/rpc",
      },
    ]);
    expect(parseOAuthCredentialSecret(store.resolve("explicit-only-oauth")!.secret!)).toMatchObject(
      {
        accessToken: "access-2",
        refreshToken: "refresh-2",
        clientId: "registered-client",
        clientSecret: "stored-private-client-secret",
        tokenEndpoint: "https://auth.example/token",
      },
    );
  });

  test("relogin never reuses private registration for a different MCP server URL", async () => {
    let authorizeCalls = 0;
    const store = new CredentialStore(undefined, new TestCipher());
    const service = new McpOAuthService({
      store,
      openExternal: () => {},
      authorizeFn: async () => {
        authorizeCalls++;
        return {
          accessToken: "access",
          refreshToken: "refresh",
          tokenType: "Bearer",
        };
      },
      fetch: (async () => new Response(null, { status: 503 })) as typeof fetch,
      logWarning: () => {},
    });
    await service.login({
      source: "mcp",
      serverName: "Original",
      serverUrl: "https://mcp.example/rpc",
      clientId: "registered-client",
      authorizationEndpoint: "https://auth.example/authorize",
      tokenEndpoint: "https://auth.example/token",
    });
    const original = store.resolve("original-oauth")!;
    const originalSecret = parseOAuthCredentialSecret(original.secret!);
    store.save("user", {
      ...original,
      secret: JSON.stringify({ ...originalSecret, clientSecret: "private-registration" }),
    });

    await expect(
      service.login({
        source: "mcp",
        serverName: "Other",
        serverUrl: "https://other-mcp.example/rpc",
        credentialId: "original-oauth",
      }),
    ).rejects.toThrow(/MCP_OAUTH_INVALID_REQUEST/);
    expect(authorizeCalls).toBe(1);
    expect(parseOAuthCredentialSecret(store.resolve("original-oauth")!.secret!)).toMatchObject({
      clientSecret: "private-registration",
      accessToken: "access",
    });
  });

  test("catalog login refuses credential ids owned by another provider or MCP server", async () => {
    let authorizeCalls = 0;
    const profile: McpOAuthProfile = {
      id: "figma-profile",
      provider: "figma",
      label: "Figma",
      serverUrl: "https://mcp.figma.example/rpc",
      clientId: "figma-client",
      authorizationEndpoint: "https://auth.figma.example/authorize",
      tokenEndpoint: "https://auth.figma.example/token",
    };
    const { service, store } = makeService({
      profiles: { "figma-profile": profile },
      authorizeTokens: () => {
        authorizeCalls += 1;
        return { accessToken: "new-access", tokenType: "Bearer" };
      },
    });
    const saveCollision = (
      id: string,
      oauthProvider: string,
      mcpServerUrl: string,
    ): void => {
      store.save("user", {
        id,
        type: "oauth",
        label: "Unrelated OAuth",
        secret: JSON.stringify({ version: 1, accessToken: `original-${id}` }),
        meta: { oauthProvider, mcpServerUrl },
      });
    };
    saveCollision("provider-collision", "other-provider", profile.serverUrl);
    saveCollision("figma-oauth", profile.provider, "https://other-mcp.example/rpc");

    await expect(
      service.login({
        source: "catalog",
        profileId: profile.id,
        credentialId: "provider-collision",
      }),
    ).rejects.toThrow(/MCP_OAUTH_INVALID_REQUEST/);
    await expect(
      service.login({ source: "catalog", profileId: profile.id }),
    ).rejects.toThrow(/MCP_OAUTH_INVALID_REQUEST/);

    expect(authorizeCalls).toBe(0);
    expect(parseOAuthCredentialSecret(store.resolve("provider-collision")!.secret!)).toMatchObject({
      accessToken: "original-provider-collision",
    });
    expect(parseOAuthCredentialSecret(store.resolve("figma-oauth")!.secret!)).toMatchObject({
      accessToken: "original-figma-oauth",
    });
  });

  test("relogin supersedes a deferred refresh and requests wait for the new login", async () => {
    const now = Date.UTC(2026, 0, 1);
    let authorizeCalls = 0;
    let finishRelogin!: (tokens: OAuthTokens) => void;
    const deferredRelogin = new Promise<OAuthTokens>((resolve) => {
      finishRelogin = resolve;
    });
    let refreshStarted!: () => void;
    const didStartRefresh = new Promise<void>((resolve) => {
      refreshStarted = resolve;
    });
    let finishOldRefresh!: (response: Response) => void;
    const deferredOldRefresh = new Promise<Response>((resolve) => {
      finishOldRefresh = resolve;
    });
    const { service, store } = makeService({
      now: () => now,
      authorizeTokens: () => {
        authorizeCalls += 1;
        if (authorizeCalls === 1) {
          return {
            accessToken: "old-access",
            refreshToken: "old-refresh",
            expiresAt: now - 1,
            tokenType: "Bearer",
          };
        }
        return deferredRelogin;
      },
      fetch: (async () => {
        refreshStarted();
        return deferredOldRefresh;
      }) as typeof fetch,
    });
    const input = {
      source: "mcp" as const,
      serverName: "Example",
      serverUrl: "https://mcp.example/rpc",
      credentialId: "example-oauth",
      clientId: "client",
      authorizationEndpoint: "https://auth.example/authorize",
      tokenEndpoint: "https://auth.example/token",
    };
    await service.login(input);

    const refreshing = service.refresh("example-oauth");
    await didStartRefresh;
    const relogin = service.login(input);
    const requestDuringLogin = service.resolveAccessToken("example-oauth");
    finishRelogin({
      accessToken: "new-login-access",
      refreshToken: "new-login-refresh",
      expiresAt: now + 3_600_000,
      tokenType: "Bearer",
    });
    await relogin;
    const requestSettledBeforeOldRefresh = await Promise.race([
      requestDuringLogin.then(() => true, () => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 0)),
    ]);

    finishOldRefresh(
      Response.json({
        access_token: "late-old-refresh-access",
        refresh_token: "late-old-refresh-token",
        expires_in: 7200,
      }),
    );
    const [refreshResult, requestResult] = await Promise.allSettled([
      refreshing,
      requestDuringLogin,
    ]);

    expect(requestSettledBeforeOldRefresh).toBe(true);
    expect(refreshResult.status).toBe("rejected");
    expect(requestResult).toEqual({
      status: "fulfilled",
      value: {
        accessToken: "new-login-access",
        expiresAt: "2026-01-01T01:00:00.000Z",
      },
    });
    const stored = store.resolve("example-oauth")!;
    expect(parseOAuthCredentialSecret(stored.secret!)).toMatchObject({
      accessToken: "new-login-access",
      refreshToken: "new-login-refresh",
    });
    expect(stored.meta?.lastRefreshAt).toBeUndefined();
    expect(stored.meta?.lastRefreshErrorCode).toBeUndefined();
  });
});
