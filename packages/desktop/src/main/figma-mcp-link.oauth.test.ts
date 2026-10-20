import { afterAll, expect, test } from "bun:test";
import http from "node:http";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";

// Synthetic official metadata is injected below. Only the actual SDK's owned
// loopback callback may reach the network, under the guarded private HOME.
if (
  !process.env.HOME ||
  !process.env.CODE_SHELL_TEST_HOME ||
  realpathSync(process.env.HOME) !== process.env.HOME ||
  process.env.CODE_SHELL_TEST_HOME !== join(process.env.HOME, ".code-shell")
)
  throw new Error("Figma OAuth fixture requires the guarded private HOME runner");
const allowed = new Set<string>();
const originalFetch = globalThis.fetch;
globalThis.fetch = ((input, init) => {
  const url = new URL(input instanceof Request ? input.url : input);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !allowed.has(url.origin))
    throw new Error("Figma OAuth fixture refused a non-callback origin");
  return originalFetch(input, { ...init, redirect: "error" });
}) as typeof fetch;
const restore: Array<() => void> = [];
for (const module of [http, https]) {
  for (const method of ["request", "get"] as const) {
    const original = module[method];
    module[method] = (() => {
      throw new Error("Figma OAuth fixture refused ambient HTTP");
    }) as typeof original;
    restore.push(() => {
      module[method] = original;
    });
  }
}
syncBuiltinESMExports();
afterAll(() => {
  globalThis.fetch = originalFetch;
  for (const undo of restore) undo();
  syncBuiltinESMExports();
});
const { CredentialStore, PlaintextCipher, parseOAuthCredentialSecret } =
  await import("@cjhyy/code-shell-core");
const { createLinkService } = await import("@cjhyy/code-shell-server/links");
const { McpOAuthService } = await import("./mcp-oauth-service.js");
const { createFigmaMcpLinkAdapter } = await import("./figma-mcp-link.js");

test("default trusted Figma profile completes SDK OAuth, account verification, Link save and restart refresh", async () => {
  const root = mkdtempSync(join(process.env.HOME!, "figma-oauth-"));
  const store = new CredentialStore(undefined, new PlaintextCipher(), root);
  const endpoint = "https://mcp.figma.com/mcp";
  const issuer = "https://api.figma.com";
  const calls: string[] = [];
  let registered: Record<string, unknown> | undefined;
  let authorization: URL | undefined;
  let browserOpened = 0;
  let tokenSequence = 0;
  let initializeName: unknown;
  const fixtureFetch = (async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    calls.push(`${request.method} ${url.origin}${url.pathname}`);
    if (url.href === "https://mcp.figma.com/.well-known/oauth-protected-resource/mcp")
      return Response.json({
        resource: endpoint,
        authorization_servers: [issuer],
        scopes_supported: ["mcp:connect"],
      });
    if (url.href === `${issuer}/.well-known/oauth-authorization-server`)
      return Response.json({
        issuer,
        authorization_endpoint: "https://www.figma.com/oauth/mcp",
        token_endpoint: `${issuer}/v1/oauth/token`,
        registration_endpoint: `${issuer}/v1/oauth/mcp/register`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        token_endpoint_auth_methods_supported: ["none"],
        code_challenge_methods_supported: ["S256"],
      });
    if (url.href === `${issuer}/v1/oauth/mcp/register`) {
      registered = (await request.json()) as Record<string, unknown>;
      expect(registered.client_name).toBe("Codex");
      expect(registered.scope).toBe("mcp:connect");
      return Response.json({ ...registered, client_id: "fixture-client" }, { status: 201 });
    }
    if (url.href === `${issuer}/v1/oauth/token`) {
      const body = new URLSearchParams(await request.text());
      expect(body.get("client_id")).toBe("fixture-client");
      if (tokenSequence === 0) {
        expect(body.get("grant_type")).toBe("authorization_code");
        expect(body.get("code")).toBe("fixture-code");
        expect(body.get("redirect_uri")).toBe(authorization?.searchParams.get("redirect_uri"));
      } else {
        expect(body.get("grant_type")).toBe("refresh_token");
        expect(body.get("refresh_token")).toBe("fixture-refresh-1");
      }
      tokenSequence++;
      return Response.json({
        access_token: `fixture-access-${tokenSequence}`,
        refresh_token: `fixture-refresh-${tokenSequence}`,
        token_type: "Bearer",
        expires_in: 3600,
        scope: "mcp:connect",
      });
    }
    if (url.href !== endpoint) throw new Error("Unexpected synthetic Figma endpoint");
    expect(request.headers.get("authorization")).toBe("Bearer fixture-access-1");
    if (request.method === "GET") return new Response(null, { status: 405 });
    const call = (await request.json()) as {
      id?: number;
      method: string;
      params?: Record<string, unknown>;
    };
    if (call.id === undefined) return new Response(null, { status: 202 });
    let result: unknown;
    if (call.method === "initialize") {
      initializeName = (call.params?.clientInfo as { name?: string })?.name;
      result = {
        protocolVersion: call.params?.protocolVersion,
        serverInfo: { name: "figma-fixture", version: "1" },
        capabilities: { tools: {}, resources: {} },
      };
    } else if (call.method === "tools/list") {
      result = {
        tools: ["whoami", "get_metadata", "use_figma"].map((name) => ({
          name,
          inputSchema: { type: "object" },
        })),
      };
    } else if (call.method === "tools/call" && call.params?.name === "whoami") {
      result = {
        content: [
          {
            type: "text",
            text: JSON.stringify({ handle: "Fixture", email: "fixture@example.test", plans: [] }),
          },
          { type: "text", text: "Account plan information." },
        ],
      };
    } else throw new Error("Connecting may only verify the account");
    return Response.json({ jsonrpc: "2.0", id: call.id, result });
  }) as typeof fetch;
  const oauth = new McpOAuthService({
    store,
    fetch: fixtureFetch,
    openExternal: () => {
      throw new Error("Host Link owns browser dispatch");
    },
  });
  const adapter = createFigmaMcpLinkAdapter({
    oauth,
    fetch: fixtureFetch,
    openExternal: async (raw) => {
      browserOpened++;
      authorization = new URL(raw);
      expect(authorization.origin + authorization.pathname).toBe("https://www.figma.com/oauth/mcp");
      const callback = new URL(authorization.searchParams.get("redirect_uri")!);
      allowed.add(callback.origin);
      callback.searchParams.set("code", "fixture-code");
      callback.searchParams.set("state", authorization.searchParams.get("state")!);
      expect((await fetch(callback)).status).toBe(200);
    },
  });
  const service = createLinkService({ store, hostOAuthAdapters: [adapter] });
  try {
    const context = { ownerId: "fixture-window", authorize: () => true };
    const job = await service.startAuthorization(
      context,
      { providerId: "figma", methodId: "mcp", label: "Figma", expectedRevision: null },
      "mcp-oauth",
    );
    expect(job.step?.kind).toBe("redirect");
    expect(store.list()).toEqual([]);
    expect(await service.openHostAuthorization(context, job.id)).toBe(true);
    let state = await service.authorization(context, job.id);
    for (let count = 0; count < 100 && state.state === "pending"; count++) {
      await new Promise((resolve) => setTimeout(resolve, 1));
      state = await service.authorization(context, job.id);
    }
    expect(state.state).toBe("connected");
    expect(initializeName).toBe("CodeShell");
    expect(browserOpened).toBe(1);
    const saved = store.resolve(state.connection!.id)!;
    expect(saved.meta?.linkAccountId).toBe("fixture@example.test");
    expect(saved.meta?.linkCapabilityIds).toEqual([
      "figma.get_metadata",
      "figma.list_resources",
      "figma.read_resource",
    ]);
    expect(saved.meta?.agentExposable).toBe(false);
    expect(JSON.stringify(state)).not.toContain("fixture-access");
    const restarted = new McpOAuthService({
      store: new CredentialStore(undefined, new PlaintextCipher(), root),
      fetch: fixtureFetch,
      openExternal: () => {
        throw new Error("Refresh cannot reopen authorization");
      },
    });
    await restarted.resolveAccessToken(saved.id, { serverUrl: endpoint, forceRefresh: true });
    expect(parseOAuthCredentialSecret(store.resolve(saved.id)!.secret!).refreshToken).toBe(
      "fixture-refresh-2",
    );
    expect(calls.filter((value) => value.includes("/v1/oauth/mcp/register"))).toHaveLength(1);
  } finally {
    service.close();
    allowed.clear();
    rmSync(root, { recursive: true, force: true });
  }
});
