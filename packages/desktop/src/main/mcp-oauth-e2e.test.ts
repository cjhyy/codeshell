import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  CredentialStore,
  PlaintextCipher,
  createMcpAuthenticatedFetch,
  parseOAuthCredentialSecret,
} from "@cjhyy/code-shell-core";
import { McpOAuthService } from "./mcp-oauth-service.js";
import { buildCredentialSnapshot } from "./credential-access-service.js";

async function requestBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("server did not bind"));
      resolve(address.port);
    });
  });
}

function close(server: Server): Promise<void> {
  server.closeAllConnections();
  return new Promise((resolve) => server.close(() => resolve()));
}

describe("MCP OAuth local protocol round-trip", () => {
  let home: string | undefined;
  let previousHome: string | undefined;
  let server: Server | undefined;
  let receiverServer: Server | undefined;

  afterEach(async () => {
    if (receiverServer) await close(receiverServer);
    receiverServer = undefined;
    if (server) await close(server);
    server = undefined;
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (home) rmSync(home, { recursive: true, force: true });
    home = undefined;
  });

  test("discovery + DCR + PKCE + rotation + one-401 retry + revoke", async () => {
    previousHome = process.env.HOME;
    home = mkdtempSync(join(tmpdir(), "codeshell-oauth-e2e-"));
    process.env.HOME = home;

    let origin = "";
    let receiverOrigin = "";
    let registrationBody: Record<string, unknown> | undefined;
    let authorizationUrl: URL | undefined;
    let callbackUrl = "";
    let duplicateCallbackRejected = false;
    let tokenSequence = 0;
    let expectedRefreshToken = "";
    const tokenBodies: URLSearchParams[] = [];
    const mcpAuthorizations: string[] = [];
    const always401Authorizations: string[] = [];
    const revokedTokens: string[] = [];
    const redirectReceiverRequests: Array<{ url: string; body: string }> = [];
    const trustedRedirectBodies: Array<{ path: string; body: string }> = [];
    let protectedDiscoveryCalls = 0;
    let authorizationDiscoveryCalls = 0;
    let registrationCalls = 0;

    server = createServer(async (req, res) => {
      const url = new URL(req.url ?? "/", origin || "http://127.0.0.1");
      const json = (status: number, body: unknown) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(body));
      };
      if (
        url.pathname === "/.well-known/oauth-protected-resource/mcp" ||
        url.pathname === "/.well-known/oauth-protected-resource"
      ) {
        protectedDiscoveryCalls++;
        json(200, {
          resource: `${origin}/mcp`,
          authorization_servers: [origin],
          scopes_supported: ["tools"],
        });
        return;
      }
      if (url.pathname === "/.well-known/oauth-authorization-server") {
        authorizationDiscoveryCalls++;
        json(200, {
          issuer: origin,
          authorization_endpoint: `${origin}/authorize`,
          token_endpoint: `${origin}/token`,
          registration_endpoint: `${origin}/register`,
          revocation_endpoint: `${origin}/revoke`,
          scopes_supported: ["tools"],
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          token_endpoint_auth_methods_supported: ["none"],
          code_challenge_methods_supported: ["S256"],
        });
        return;
      }
      if (url.pathname === "/register" && req.method === "POST") {
        registrationCalls++;
        registrationBody = JSON.parse(await requestBody(req)) as Record<string, unknown>;
        json(201, { ...registrationBody, client_id: "dynamic-client" });
        return;
      }
      if (url.pathname === "/redirect-token" && req.method === "POST") {
        trustedRedirectBodies.push({ path: url.pathname, body: await requestBody(req) });
        res.writeHead(307, { Location: `${receiverOrigin}/collect-token` }).end();
        return;
      }
      if (url.pathname === "/redirect-revoke" && req.method === "POST") {
        trustedRedirectBodies.push({ path: url.pathname, body: await requestBody(req) });
        res.writeHead(308, { Location: `${receiverOrigin}/collect-revoke` }).end();
        return;
      }
      if (url.pathname === "/token" && req.method === "POST") {
        const params = new URLSearchParams(await requestBody(req));
        tokenBodies.push(params);
        tokenSequence++;
        if (params.get("grant_type") === "authorization_code") {
          const verifier = params.get("code_verifier") ?? "";
          const recomputed = createHash("sha256").update(verifier).digest("base64url");
          expect(params.get("code")).toBe("local-auth-code");
          expect(params.get("client_id")).toBe("dynamic-client");
          expect(recomputed).toBe(authorizationUrl?.searchParams.get("code_challenge"));
        } else {
          expect(params.get("grant_type")).toBe("refresh_token");
          expect(params.get("refresh_token")).toBe(expectedRefreshToken);
        }
        expectedRefreshToken = `refresh-${tokenSequence}`;
        json(200, {
          access_token: `access-${tokenSequence}`,
          refresh_token: expectedRefreshToken,
          token_type: "Bearer",
          expires_in: tokenSequence === 1 ? 1 : 3600,
          scope: "tools",
        });
        return;
      }
      if (url.pathname === "/mcp") {
        const authorization = req.headers.authorization ?? "";
        mcpAuthorizations.push(authorization);
        if (authorization !== "Bearer access-3") {
          res.writeHead(401).end();
          return;
        }
        if (req.method !== "POST") {
          res.writeHead(405, { Allow: "POST" }).end();
          return;
        }
        const message = JSON.parse(await requestBody(req)) as {
          jsonrpc: "2.0";
          id?: string | number;
          method?: string;
          params?: { protocolVersion?: string };
        };
        if (message.method === "initialize") {
          json(200, {
            jsonrpc: "2.0",
            id: message.id,
            result: {
              protocolVersion: message.params?.protocolVersion ?? "2025-03-26",
              capabilities: { tools: {} },
              serverInfo: { name: "local-oauth-mcp", version: "1.0.0" },
            },
          });
        } else if (message.method === "notifications/initialized") {
          res.writeHead(202).end();
        } else if (message.method === "tools/list") {
          json(200, {
            jsonrpc: "2.0",
            id: message.id,
            result: {
              tools: [
                {
                  name: "local-tool",
                  description: "Local OAuth MCP tool",
                  inputSchema: { type: "object", properties: {} },
                },
              ],
            },
          });
        } else {
          json(400, {
            jsonrpc: "2.0",
            id: message.id ?? null,
            error: { code: -32601, message: "Method not found" },
          });
        }
        return;
      }
      if (url.pathname === "/always-401") {
        always401Authorizations.push(req.headers.authorization ?? "");
        res.writeHead(401).end();
        return;
      }
      if (url.pathname === "/revoke" && req.method === "POST") {
        const params = new URLSearchParams(await requestBody(req));
        revokedTokens.push(params.get("token") ?? "");
        res.writeHead(200).end();
        return;
      }
      res.writeHead(404).end();
    });
    origin = `http://127.0.0.1:${await listen(server)}`;
    receiverServer = createServer(async (req, res) => {
      redirectReceiverRequests.push({
        url: req.url ?? "",
        body: await requestBody(req),
      });
      res.writeHead(200).end();
    });
    receiverOrigin = `http://127.0.0.1:${await listen(receiverServer)}`;

    const store = new CredentialStore(undefined, new PlaintextCipher());
    const service = new McpOAuthService({
      store,
      openExternal: async (rawUrl) => {
        authorizationUrl = new URL(rawUrl);
        expect(authorizationUrl.searchParams.get("state")).toMatch(/^[a-f0-9]{32}$/);
        expect(authorizationUrl.searchParams.get("code_challenge_method")).toBe("S256");
        callbackUrl = authorizationUrl.searchParams.get("redirect_uri")!;
        const callback = new URL(callbackUrl);
        callback.searchParams.set("code", "local-auth-code");
        callback.searchParams.set("state", authorizationUrl.searchParams.get("state")!);
        expect((await fetch(callback)).status).toBe(200);
        try {
          const duplicate = await fetch(callback, { signal: AbortSignal.timeout(200) });
          duplicateCallbackRejected = duplicate.status !== 200;
        } catch {
          duplicateCallbackRejected = true;
        }
      },
      logWarning: () => {},
    });

    const login = await service.login({
      source: "mcp",
      serverName: "Local MCP",
      serverUrl: `${origin}/mcp`,
    });
    expect(login.credential.id).toBe("local-mcp-oauth");
    expect(protectedDiscoveryCalls).toBe(1);
    expect(authorizationDiscoveryCalls).toBe(1);
    expect(registrationCalls).toBe(1);
    expect(registrationBody).toMatchObject({
      client_name: "CodeShell",
      token_endpoint_auth_method: "none",
      scope: "tools",
    });
    expect(duplicateCallbackRejected).toBe(true);
    await expect(fetch(callbackUrl, { signal: AbortSignal.timeout(200) })).rejects.toThrow();

    expect(parseOAuthCredentialSecret(store.resolve("local-mcp-oauth")!.secret!)).toMatchObject({
      accessToken: "access-1",
      refreshToken: "refresh-1",
      clientId: "dynamic-client",
      tokenEndpoint: `${origin}/token`,
      revocationEndpoint: `${origin}/revoke`,
    });
    await expect(service.resolveAccessToken("local-mcp-oauth")).resolves.toMatchObject({
      accessToken: "access-2",
    });

    const access = {
      listMasked: () => [],
      resolveMeta: () => ({
        id: "local-mcp-oauth",
        type: "oauth" as const,
        label: "Local MCP",
        hasSecret: true,
      }),
      envExposures: () => ({}),
      resolveOAuthAccess: (request: { forceRefresh?: boolean }) =>
        service.resolveAccessToken("local-mcp-oauth", {
          forceRefresh: Boolean(request.forceRefresh),
        }),
    };
    const authenticatedFetch = createMcpAuthenticatedFetch(
      "local",
      {
        name: "local",
        transport: "streamable-http",
        url: `${origin}/mcp`,
        credentialRef: "local-mcp-oauth",
      },
      access,
      fetch,
    );

    const mcpClient = new Client(
      { name: "oauth-e2e-client", version: "1.0.0" },
      { capabilities: {} },
    );
    const mcpTransport = new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), {
      fetch: authenticatedFetch as never,
    });
    await mcpClient.connect(mcpTransport);
    const listedTools = await mcpClient.listTools();
    expect(listedTools.tools.map((tool) => tool.name)).toEqual(["local-tool"]);
    await mcpClient.close();
    expect(mcpAuthorizations.slice(0, 2)).toEqual(["Bearer access-2", "Bearer access-3"]);
    expect(mcpAuthorizations.slice(2).length).toBeGreaterThanOrEqual(2);
    expect(mcpAuthorizations.slice(2).every((value) => value === "Bearer access-3")).toBe(true);

    expect((await authenticatedFetch(`${origin}/always-401`, { method: "POST" })).status).toBe(401);
    expect(always401Authorizations).toEqual(["Bearer access-3", "Bearer access-4"]);
    expect(tokenBodies).toHaveLength(4);

    const current = store.resolve("local-mcp-oauth")!;
    const currentSecret = parseOAuthCredentialSecret(current.secret!);
    store.save("user", {
      ...current,
      secret: JSON.stringify({
        ...currentSecret,
        tokenEndpoint: `${origin}/redirect-token`,
        revocationEndpoint: `${origin}/redirect-revoke`,
      }),
    });
    await expect(service.refresh("local-mcp-oauth")).rejects.toThrow(/refresh failed/);

    await expect(service.logout("local-mcp-oauth")).resolves.toEqual({
      removed: true,
      remoteRevoked: false,
    });
    expect(revokedTokens).toEqual([]);
    expect(trustedRedirectBodies.map((request) => request.path)).toEqual([
      "/redirect-token",
      "/redirect-revoke",
    ]);
    expect(trustedRedirectBodies[0]?.body).toContain("refresh-4");
    expect(trustedRedirectBodies[1]?.body).toContain("refresh-4");
    expect(redirectReceiverRequests).toEqual([]);
    expect(store.resolve("local-mcp-oauth")).toBeUndefined();
  });

  test("logout tombstones a deferred discovery relogin before its late token response", async () => {
    previousHome = process.env.HOME;
    home = mkdtempSync(join(tmpdir(), "codeshell-oauth-discovery-race-"));
    process.env.HOME = home;

    let origin = "";
    let tokenRequestStarted!: () => void;
    const didStartTokenRequest = new Promise<void>((resolve) => {
      tokenRequestStarted = resolve;
    });
    let finishTokenResponse!: () => void;
    server = createServer(async (req, res) => {
      const url = new URL(req.url ?? "/", origin || "http://127.0.0.1");
      const json = (status: number, body: unknown) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(body));
      };
      if (
        url.pathname === "/.well-known/oauth-protected-resource/mcp" ||
        url.pathname === "/.well-known/oauth-protected-resource"
      ) {
        json(200, { resource: `${origin}/mcp`, authorization_servers: [origin] });
        return;
      }
      if (url.pathname === "/.well-known/oauth-authorization-server") {
        json(200, {
          issuer: origin,
          authorization_endpoint: `${origin}/authorize`,
          token_endpoint: `${origin}/token`,
          registration_endpoint: `${origin}/register`,
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          token_endpoint_auth_methods_supported: ["none"],
          code_challenge_methods_supported: ["S256"],
        });
        return;
      }
      if (url.pathname === "/register" && req.method === "POST") {
        const registration = JSON.parse(await requestBody(req)) as Record<string, unknown>;
        json(201, { ...registration, client_id: "dynamic-client" });
        return;
      }
      if (url.pathname === "/token" && req.method === "POST") {
        await requestBody(req);
        tokenRequestStarted();
        finishTokenResponse = () =>
          json(200, {
            access_token: "late-discovery-access",
            refresh_token: "late-discovery-refresh",
            token_type: "Bearer",
            expires_in: 3600,
          });
        return;
      }
      res.writeHead(404).end();
    });
    origin = `http://127.0.0.1:${await listen(server)}`;

    let invalidations = 0;
    const store = new CredentialStore(undefined, new PlaintextCipher());
    store.save("user", {
      id: "local-mcp-oauth",
      type: "oauth",
      label: "Local MCP OAuth",
      secret: JSON.stringify({
        version: 1,
        accessToken: "old-access",
        refreshToken: "old-refresh",
      }),
      meta: { mcpServerName: "Local MCP", mcpServerUrl: `${origin}/mcp` },
    });
    const service = new McpOAuthService({
      store,
      onCredentialsChanged: () => invalidations++,
      openExternal: async (rawUrl) => {
        const authorizationUrl = new URL(rawUrl);
        const callback = new URL(authorizationUrl.searchParams.get("redirect_uri")!);
        callback.searchParams.set("code", "local-auth-code");
        callback.searchParams.set("state", authorizationUrl.searchParams.get("state")!);
        expect((await fetch(callback)).status).toBe(200);
      },
      logWarning: () => {},
    });

    const relogin = service.login({
      source: "mcp",
      serverName: "Local MCP",
      serverUrl: `${origin}/mcp`,
      credentialId: "local-mcp-oauth",
    });
    await didStartTokenRequest;
    await expect(service.logout("local-mcp-oauth")).resolves.toEqual({
      removed: true,
      remoteRevoked: true,
    });
    expect(store.resolve("local-mcp-oauth")).toBeUndefined();
    expect(buildCredentialSnapshot([], 7).entries[0]?.full).toEqual([]);
    expect(invalidations).toBe(1);

    finishTokenResponse();
    await expect(relogin).rejects.toThrow();
    expect(store.resolve("local-mcp-oauth")).toBeUndefined();
    expect(buildCredentialSnapshot([], 8).entries[0]?.full).toEqual([]);
    expect(invalidations).toBe(1);
  });

  test("discovery without a registration endpoint fails closed before authorization", async () => {
    previousHome = process.env.HOME;
    home = mkdtempSync(join(tmpdir(), "codeshell-oauth-no-dcr-"));
    process.env.HOME = home;

    let origin = "";
    server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", origin || "http://127.0.0.1");
      const json = (body: unknown) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(body));
      };
      if (
        url.pathname === "/.well-known/oauth-protected-resource/mcp" ||
        url.pathname === "/.well-known/oauth-protected-resource"
      ) {
        json({ resource: `${origin}/mcp`, authorization_servers: [origin] });
        return;
      }
      if (url.pathname === "/.well-known/oauth-authorization-server") {
        json({
          issuer: origin,
          authorization_endpoint: `${origin}/authorize`,
          token_endpoint: `${origin}/token`,
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          token_endpoint_auth_methods_supported: ["none"],
          code_challenge_methods_supported: ["S256"],
        });
        return;
      }
      res.writeHead(404).end();
    });
    origin = `http://127.0.0.1:${await listen(server)}`;
    let browserOpens = 0;
    const store = new CredentialStore(undefined, new PlaintextCipher());
    const service = new McpOAuthService({
      store,
      openExternal: () => {
        browserOpens++;
      },
      logWarning: () => {},
    });

    await expect(
      service.login({ source: "mcp", serverName: "No DCR", serverUrl: `${origin}/mcp` }),
    ).rejects.toThrow(/MCP_OAUTH_PROTOCOL_ERROR/);
    expect(browserOpens).toBe(0);
    expect(store.list()).toEqual([]);
  });
});
