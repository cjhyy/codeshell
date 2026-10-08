import { afterAll, afterEach, describe, expect, test } from "bun:test";
import http, { createServer, type Server } from "node:http";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";

// Install an exact-origin guard before importing either SDK or Core. The guarded
// runner supplies this real private HOME; no operator credentials are inherited.
if (
  !process.env.HOME ||
  !process.env.CODE_SHELL_TEST_HOME ||
  realpathSync(process.env.HOME) !== process.env.HOME ||
  process.env.CODE_SHELL_TEST_HOME !== join(process.env.HOME, ".code-shell")
) {
  throw new Error("OAuth issuer fixtures require the guarded private HOME runner");
}
const allowedOrigins = new Set<string>();
const originalFetch = globalThis.fetch;
const assertOrigin = (raw: string | URL): void => {
  const url = new URL(raw);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !allowedOrigins.has(url.origin)) {
    throw new Error("OAuth issuer fixture refused a non-fixture origin");
  }
};
globalThis.fetch = ((input, init) => {
  assertOrigin(input instanceof Request ? input.url : input);
  if ((init as RequestInit & { dispatcher?: unknown })?.dispatcher) {
    throw new Error("OAuth issuer fixture refused a custom dispatcher");
  }
  return originalFetch(input, { ...init, redirect: "error" });
}) as typeof fetch;
const restoreHttp: Array<() => void> = [];
for (const [module, protocol] of [
  [http, "http:"],
  [https, "https:"],
] as const) {
  for (const method of ["request", "get"] as const) {
    const original = module[method];
    module[method] = ((input: string | URL | http.RequestOptions, ...args: unknown[]) => {
      const url = typeof input === "string" || input instanceof URL ? new URL(input) : undefined;
      const options = url ? (typeof args[0] === "object" ? args[0] : {}) : input;
      const settings = (options ?? {}) as http.RequestOptions;
      if (settings.socketPath || settings.createConnection || settings.lookup || settings.agent) {
        throw new Error("OAuth issuer fixture refused a custom transport");
      }
      assertOrigin(
        `${settings.protocol ?? url?.protocol ?? protocol}//${settings.hostname ?? settings.host ?? url?.hostname ?? "localhost"}:${settings.port ?? url?.port ?? (protocol === "https:" ? 443 : 80)}`,
      );
      return Reflect.apply(original, module, [input, ...args]);
    }) as typeof original;
    restoreHttp.push(() => {
      module[method] = original;
    });
  }
}
syncBuiltinESMExports();
const guardReceipt = {
  pid: process.pid,
  ppid: process.ppid,
  homeId: createHash("sha256").update(process.env.HOME!).digest("hex"),
  installedBeforeImports: true,
};
expect(() => fetch("https://oauth-issuer-non-fixture.invalid")).toThrow(/non-fixture origin/);
expect(() => http.request("http://127.0.0.1:1")).toThrow(/non-fixture origin/);
console.info("mcp.oauth.issuer.preimport", { ...guardReceipt, origins: [] });
const { auth } = await import("@modelcontextprotocol/sdk/client/auth.js");
const { CredentialStore, PlaintextCipher, parseOAuthCredentialSecret } =
  await import("@cjhyy/code-shell-core");
const { McpOAuthService } = await import("./mcp-oauth-service.js");
type Provider = import("@modelcontextprotocol/sdk/client/auth.js").OAuthClientProvider;

const servers: Server[] = [];
const roots: string[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  allowedOrigins.clear();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
afterAll(() => {
  globalThis.fetch = originalFetch;
  for (const restore of restoreHttp) restore();
  syncBuiltinESMExports();
});

interface RecordedRequest {
  server: string;
  path: string;
  body: string;
  authorization?: string;
}

async function fixture() {
  const requests: RecordedRequest[] = [];
  const external: URL[] = [];
  let selectedIssuer = "";
  let metadataIssuer: string | undefined;
  async function listen(name: string): Promise<string> {
    let origin = "";
    const server = createServer(async (req, res) => {
      let body = "";
      for await (const chunk of req) body += String(chunk);
      const path = new URL(req.url!, origin).pathname;
      requests.push({ server: name, path, body, authorization: req.headers.authorization });
      const json = (value: unknown, status = 200) => {
        res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(value));
      };
      if (path.startsWith("/.well-known/oauth-protected-resource")) {
        return json({ resource: `${origin}/mcp`, authorization_servers: [selectedIssuer] });
      }
      if (path === "/.well-known/oauth-authorization-server") {
        return json({
          issuer: metadataIssuer ?? origin,
          authorization_endpoint: `${origin}/authorize`,
          token_endpoint: `${origin}/token`,
          registration_endpoint: `${origin}/register`,
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          token_endpoint_auth_methods_supported: ["client_secret_post", "none"],
          code_challenge_methods_supported: ["S256"],
        });
      }
      if (path === "/register") {
        return json(
          {
            ...JSON.parse(body),
            client_id: `${name}-client`,
            client_secret: `${name}-client-secret`,
            token_endpoint_auth_method: "client_secret_post",
            issuer: "https://untrusted-response.example",
          },
          201,
        );
      }
      if (path === "/token") {
        return json({
          access_token: `${name}-access`,
          refresh_token: `${name}-refresh`,
          token_type: "Bearer",
          expires_in: 3600,
          issuer: "https://untrusted-response.example",
        });
      }
      res.writeHead(404).end();
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    allowedOrigins.add(origin);
    return origin;
  }
  const a = await listen("a"),
    b = await listen("b");
  console.info("mcp.oauth.issuer.fixture", { ...guardReceipt, origins: [a, b] });
  selectedIssuer = a;
  const root = mkdtempSync(join(process.env.HOME!, "oauth-issuer-"));
  roots.push(root);
  const store = new CredentialStore(undefined, new PlaintextCipher(), root);
  const service = new McpOAuthService({
    store,
    logWarning: () => {},
    openExternal: async (raw) => {
      const url = new URL(raw);
      external.push(url);
      const callback = new URL(url.searchParams.get("redirect_uri")!);
      // The only extra origin is the exact callback listener created by the service.
      expect(callback.hostname).toBe("127.0.0.1");
      allowedOrigins.add(callback.origin);
      callback.searchParams.set("code", "synthetic-code");
      callback.searchParams.set("state", url.searchParams.get("state")!);
      selectedIssuer = b;
      expect((await fetch(callback)).status).toBe(200);
    },
  });
  const login = {
    source: "mcp" as const,
    serverName: "Fixture",
    serverUrl: `${a}/mcp`,
    credentialId: "fixture",
  };
  const save = (secret: Record<string, unknown>, meta: Record<string, unknown> = {}) => {
    store.save("user", {
      id: "fixture",
      type: "oauth",
      label: "Fixture OAuth",
      secret: JSON.stringify({ accessToken: "legacy-access", ...secret }),
      meta: { mcpServerUrl: login.serverUrl, ...meta },
    });
  };
  return {
    a,
    b,
    requests,
    external,
    store,
    service,
    login,
    save,
    select: (issuer: string) => {
      selectedIssuer = issuer;
    },
    echoIssuer: (issuer: string) => {
      metadataIssuer = issuer;
    },
  };
}

describe("actual SDK OAuth issuer binding with two controlled authorization servers", () => {
  test("Desktop pins both auth legs and refresh to the actual AS, preserving SDK issuer stamps", async () => {
    const f = await fixture();
    f.echoIssuer(f.b); // SDK 1.31 does not validate this metadata echo; it binds to discovery's URL.
    await f.service.login(f.login);
    const saved = parseOAuthCredentialSecret(f.store.resolve("fixture")!.secret!);
    expect(saved.issuer).toBe(f.a);
    expect(saved.clientRegistration?.issuer).toBe(f.a);
    expect(saved.clientSecret).toBe("a-client-secret");
    expect(f.store.resolve("fixture")!.meta?.issuer).toBe(f.a);
    expect(f.external).toHaveLength(1);
    expect(f.external[0].origin).toBe(f.a);
    expect(
      f.requests.filter((r) => r.path.startsWith("/.well-known/oauth-protected-resource")),
    ).toHaveLength(1);
    // openExternal switched discovery to B before the callback. The temporary
    // provider retains its exact saved discovery/client information for leg two.
    await f.service.refresh("fixture");
    const sent = f.requests.filter((r) => r.path === "/token");
    expect(sent).toHaveLength(2);
    expect(sent.every((r) => r.server === "a")).toBe(true);
    expect(new URLSearchParams(sent[0].body).get("client_secret")).toBe("a-client-secret");
    expect(new URLSearchParams(sent[1].body).get("refresh_token")).toBe("a-refresh");
    expect(new URLSearchParams(sent[1].body).get("client_secret")).toBe("a-client-secret");
    expect(f.requests.some((r) => r.server === "b")).toBe(false);
  });

  test("SDK refuses pre-registered secrets bound to A when the MCP resource advertises B", async () => {
    const f = await fixture();
    const provider: Provider = {
      redirectUrl: `${f.a}/callback`,
      clientMetadata: { redirect_uris: [`${f.a}/callback`] },
      clientInformation: () => ({
        client_id: "a-client",
        client_secret: "a-secret",
        issuer: `${f.a}/`,
      }),
      tokens: () => ({
        access_token: "old-access",
        refresh_token: "old-refresh",
        token_type: "Bearer",
        issuer: f.a,
      }),
      saveTokens: () => {},
      saveCodeVerifier: () => {},
      codeVerifier: () => "verifier",
      redirectToAuthorization: () => {
        throw new Error("Bound credentials must not redirect");
      },
    };
    await expect(auth(provider, { serverUrl: f.login.serverUrl })).resolves.toBe("AUTHORIZED");
    f.select(f.b);
    await expect(auth(provider, { serverUrl: f.login.serverUrl })).rejects.toThrow(
      /bound to authorization server/,
    );
    const posts = f.requests.filter((r) => r.path === "/token");
    expect(posts).toHaveLength(1);
    expect(posts[0].server).toBe("a");
    expect(new URLSearchParams(posts[0].body).get("refresh_token")).toBe("old-refresh");
    expect(new URLSearchParams(posts[0].body).get("client_secret")).toBe("a-secret");
  });

  test("SDK discards a token stamped for A before starting a new interactive sign-in at B", async () => {
    const f = await fixture();
    f.select(f.b);
    const redirected: URL[] = [];
    const provider: Provider = {
      redirectUrl: `${f.a}/callback`,
      clientMetadata: { redirect_uris: [`${f.a}/callback`] },
      clientInformation: () => ({ client_id: "public-b", issuer: f.b }),
      tokens: () => ({
        access_token: "a-access",
        refresh_token: "a-refresh",
        token_type: "Bearer",
        issuer: f.a,
      }),
      saveTokens: () => {},
      saveCodeVerifier: () => {},
      codeVerifier: () => "verifier",
      redirectToAuthorization: (url) => {
        redirected.push(url);
      },
    };
    await expect(auth(provider, { serverUrl: f.login.serverUrl })).resolves.toBe("REDIRECT");
    expect(redirected[0].origin).toBe(f.b);
    expect(f.requests.filter((r) => r.path === "/token")).toHaveLength(0);
    expect(JSON.stringify(f.requests)).not.toContain("a-refresh");
  });

  test("new public pre-registration without issuer receives SDK stamps after interactive login", async () => {
    const f = await fixture();
    await f.service.login({ ...f.login, clientId: "public-client" });
    expect(f.requests.filter((r) => r.path === "/register")).toHaveLength(0);
    expect(f.external).toHaveLength(1);
    const saved = parseOAuthCredentialSecret(f.store.resolve("fixture")!.secret!);
    expect(saved.issuer).toBe(f.a);
    expect(saved.clientRegistration).toMatchObject({ clientId: "public-client", issuer: f.a });
  });

  test("legacy issuer fallback stamps only the public client ID and never sends the old private secret", async () => {
    const f = await fixture();
    // The SDK tolerates one trailing slash relative to the parsed discovery URL.
    f.save({ clientId: "legacy-public", clientSecret: "legacy-private", issuer: `${f.a}//` });
    await f.service.login(f.login);
    expect(f.requests.filter((r) => r.path === "/register")).toHaveLength(0);
    expect(f.requests.filter((r) => r.path === "/token")).toHaveLength(1);
    expect(JSON.stringify(f.requests)).not.toContain("legacy-private");
    expect(parseOAuthCredentialSecret(f.store.resolve("fixture")!.secret!).issuer).toBe(f.a);
    expect(
      parseOAuthCredentialSecret(f.store.resolve("fixture")!.secret!).clientRegistration?.issuer,
    ).toBe(`${f.a}//`);
  });

  test("unbound legacy registration cannot enter Desktop SDK discovery or lose the old credential", async () => {
    const f = await fixture();
    f.save({
      clientId: "legacy-public",
      clientSecret: "legacy-private",
      refreshToken: "legacy-refresh",
    });
    const prior = f.store.resolve("fixture")!.secret;
    await expect(f.service.login(f.login)).rejects.toThrow(/has no issuer; use a new credential/);
    expect(f.requests).toHaveLength(0);
    expect(f.external).toHaveLength(0);
    expect(f.store.resolve("fixture")!.secret).toBe(prior);
  });

  test.each(["authorization", "token", "both"])(
    "relogin refuses %s endpoint replacement before sending a saved client secret",
    async (changed) => {
      const f = await fixture();
      f.save(
        { clientId: "a-client", clientSecret: "a-secret", tokenEndpoint: `${f.a}/token` },
        { authUrl: `${f.a}/authorize` },
      );
      await expect(
        f.service.login({
          ...f.login,
          authorizationEndpoint: `${changed === "token" ? f.a : f.b}/authorize`,
          tokenEndpoint: `${changed === "authorization" ? f.a : f.b}/token`,
        }),
      ).rejects.toThrow(/bound to other endpoints; use a new credential/);
      expect(f.requests).toHaveLength(0);
      expect(f.external).toHaveLength(0);
      expect(parseOAuthCredentialSecret(f.store.resolve("fixture")!.secret!).clientSecret).toBe(
        "a-secret",
      );
    },
  );

  test("legacy custom refresh without issuer keeps its stored endpoint despite changed discovery", async () => {
    const f = await fixture();
    f.save({
      clientId: "legacy-client",
      clientSecret: "legacy-secret",
      refreshToken: "legacy-refresh",
      tokenEndpoint: `${f.a}/token`,
    });
    f.select(f.b);
    await f.service.refresh("fixture");
    expect(f.requests).toHaveLength(1);
    expect(f.requests[0]).toMatchObject({ server: "a", path: "/token" });
    expect(new URLSearchParams(f.requests[0].body).get("refresh_token")).toBe("legacy-refresh");
    expect(new URLSearchParams(f.requests[0].body).get("client_secret")).toBe("legacy-secret");
    expect(parseOAuthCredentialSecret(f.store.resolve("fixture")!.secret!).issuer).toBeUndefined();
  });
});
