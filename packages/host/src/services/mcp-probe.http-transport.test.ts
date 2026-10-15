import { afterAll, afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { installFixtureNetworkGuard } from "../../../../tests/helpers/network-fixture.js";
const origin = "http://127.0.0.1:34722";
let handle: (request: Request) => Promise<Response> = async () => {
  throw new Error("No fixture handler");
};
const network = installFixtureNetworkGuard((async (input: any, init?: RequestInit) =>
  handle(new Request(input, init))) as typeof fetch);
network.allowOrigin(origin);
afterAll(() => network.restore());
const { CredentialStore, PlaintextCipher, setDefaultCredentialCipher } =
  await import("@cjhyy/code-shell-core");
const { probeMcp } = await import("@cjhyy/code-shell-host");
const { probeMcpServer, invalidateMcpProbeCache } =
  await import("../../../desktop/src/main/mcp-probe-service.js");
const cleanup: (() => void)[] = [];
afterEach(() => {
  invalidateMcpProbeCache();
  setDefaultCredentialCipher(null);
  for (const run of cleanup.splice(0).reverse()) run();
});
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "http-probe-transport-"));
  const old = process.env.HOME;
  process.env.HOME = join(dir, "home");
  mkdirSync(process.env.HOME);
  cleanup.push(() => {
    if (old === undefined) delete process.env.HOME;
    else process.env.HOME = old;
    rmSync(dir, { recursive: true, force: true });
  });
  setDefaultCredentialCipher(new PlaintextCipher());
  const store = new CredentialStore();
  let lists = 0,
    initializations = 0;
  const authorizations: string[] = [];
  handle = async (request) => {
    expect(new URL(request.url).origin).toBe(origin);
    expect(request.redirect).toBe("error");
    if (request.method !== "POST") return new Response(null, { status: 405 });
    const input = await request.json();
    authorizations.push(request.headers.get("authorization") ?? "");
    if (
      request.headers.get("authorization") !== "Bearer refreshed-secret" &&
      request.headers.get("authorization") !== "Bearer current-secret"
    )
      return new Response("upstream-secret", { status: 401 });
    if (input.id === undefined) return new Response(null, { status: 202 });
    const result =
      input.method === "initialize"
        ? (++initializations,
          {
            protocolVersion: "2024-11-05",
            capabilities: { tools: {} },
            serverInfo: { name: "fixture", version: "1" },
          })
        : (++lists,
          {
            tools: [
              {
                name: "fixture_tool",
                description: "current-secret refreshed-secret private-query",
                inputSchema: { type: "object", properties: {} },
              },
            ],
          });
    return Response.json({ jsonrpc: "2.0", id: input.id, result });
  };
  return { dir, store, authorizations, lists: () => lists, initializations: () => initializations };
}

test("Desktop OAuth resolver refreshes once after 401 and every HTTP page uses current credentials", async () => {
  const f = fixture();
  f.store.save("user", {
    id: "oauth",
    type: "oauth",
    label: "Fixture",
    secret: JSON.stringify({
      accessToken: "expired-secret",
      expiresAt: "2099-01-01T00:00:00.000Z",
    }),
  });
  const resolutions: boolean[] = [];
  let refreshed = false;
  const oauthService = {
    resolveAccessToken: async (_id: string, options?: { forceRefresh?: boolean }) => {
      resolutions.push(!!options?.forceRefresh);
      if (options?.forceRefresh) refreshed = true;
      return { accessToken: refreshed ? "refreshed-secret" : "expired-secret" };
    },
  };
  const config = {
    name: "oauth-fixture",
    url: `${origin}/mcp?access=private-query`,
    credentialRef: "oauth",
  };
  const result = await probeMcpServer(config, { cwd: f.dir, oauthService });
  expect(result.status).toBe("ok");
  expect(result.toolCount).toBe(1);
  expect(resolutions.filter(Boolean)).toHaveLength(1);
  expect(f.authorizations).toContain("Bearer expired-secret");
  expect(f.authorizations).toContain("Bearer refreshed-secret");
  expect(JSON.stringify(result)).not.toMatch(
    /expired-secret|refreshed-secret|private-query|upstream-secret/,
  );
  const before = f.initializations();
  expect((await probeMcpServer(config, { cwd: f.dir, oauthService })).status).toBe("ok");
  expect(f.initializations()).toBe(before + 1); // unversioned auth never hits the cache
});
test("credentialRef mutation/revocation cannot return a cached successful preview", async () => {
  const f = fixture();
  const config = {
    name: "token-fixture",
    url: `${origin}/mcp?access=private-query`,
    credentialRef: "token",
  };
  const save = (secret: string) =>
    f.store.save("user", { id: "token", type: "token", label: "Fixture", secret });
  save("current-secret");
  expect((await probeMcpServer(config, { cwd: f.dir })).status).toBe("ok");
  save("revoked-secret");
  const denied = await probeMcpServer(config, { cwd: f.dir });
  expect(denied.status).toBe("error");
  expect(denied.tools).toBeUndefined();
  expect(JSON.stringify(denied)).not.toMatch(/current-secret|revoked-secret|upstream-secret/);
});
test("a pending HTTP response is cancelled on owner revocation", async () => {
  const f = fixture();
  let started!: () => void;
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  handle = async (request) => {
    expect(new URL(request.url).origin).toBe(origin);
    started();
    return new Promise((_resolve, reject) =>
      request.signal.addEventListener(
        "abort",
        () => reject(new Error("cancelled private-secret")),
        { once: true },
      ),
    );
  };
  const controller = new AbortController();
  const pending = probeMcp(
    { name: "cancel", url: `${origin}/mcp` },
    { cwd: f.dir, signal: controller.signal },
  );
  await entered;
  controller.abort();
  const result = await pending;
  expect(result.status).toBe("cancelled");
  expect(JSON.stringify(result)).not.toContain("private-secret");
});

test.each(["preview", "repeat", "total"] as const)(
  "HTTP transport enforces shared result bounds (%s)",
  async (mode) => {
    const f = fixture();
    let pages = 0;
    handle = async (request) => {
      expect(new URL(request.url).origin).toBe(origin);
      if (request.method !== "POST") return new Response(null, { status: 405 });
      const input = await request.json();
      if (input.id === undefined) return new Response(null, { status: 202 });
      let result: unknown;
      if (input.method === "initialize")
        result = {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "fixture", version: "1" },
        };
      else {
        pages++;
        result = {
          tools: Array.from({ length: mode === "preview" ? 150 : 1 }, (_, index) => ({
            name: `tool_${index}`,
            description: "x".repeat(mode === "total" ? 400_000 : 0),
            inputSchema: { type: "object", properties: {} },
          })),
          ...(mode === "repeat"
            ? { nextCursor: "same" }
            : mode === "total"
              ? { nextCursor: String(pages) }
              : {}),
        };
      }
      return Response.json({ jsonrpc: "2.0", id: input.id, result });
    };
    const result = await probeMcp({ name: "bounded", url: `${origin}/mcp` }, { cwd: f.dir });
    if (mode === "preview") {
      expect(result).toMatchObject({ status: "ok", toolCount: 150, truncated: true });
      expect(result.tools).toHaveLength(100);
    } else {
      expect(result.error?.code).toBe(
        mode === "repeat" ? "invalid_protocol" : "response_too_large",
      );
      expect(pages).toBeLessThanOrEqual(8);
    }
  },
);

test.each([400, 403, 404])(
  "optional SDK GET/SSE diagnostic %s cannot poison POST tools before or between pages",
  async (status) => {
    for (const timing of ["before", "between"] as const) {
      const f = fixture();
      let gotGet!: () => void, firstPage!: () => void;
      const getFinished = new Promise<void>((resolve) => {
        gotGet = resolve;
      });
      const pageReturned = new Promise<void>((resolve) => {
        firstPage = resolve;
      });
      const events: string[] = [];
      handle = async (request) => {
        if (request.method === "GET") {
          if (timing === "between") await pageReturned;
          events.push("GET diagnostic");
          return new Response(
            new ReadableStream({
              cancel() {
                events.push("GET body cancelled");
                gotGet();
              },
            }),
            { status },
          );
        }
        if (request.method !== "POST") return new Response(null, { status: 405 });
        const input = await request.json();
        if (input.id === undefined) return new Response(null, { status: 202 });
        if (input.method === "initialize")
          return Response.json({
            jsonrpc: "2.0",
            id: input.id,
            result: {
              protocolVersion: "2024-11-05",
              capabilities: { tools: {} },
              serverInfo: { name: "fixture", version: "1" },
            },
          });
        const next = input.params?.cursor === "second";
        if (timing === "before" || next) {
          await getFinished;
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
        events.push(next ? "second tools" : "first tools");
        firstPage();
        return Response.json({
          jsonrpc: "2.0",
          id: input.id,
          result: {
            tools: [
              { name: next ? "second" : "first", inputSchema: { type: "object", properties: {} } },
            ],
            ...(!next ? { nextCursor: "second" } : {}),
          },
        });
      };
      const result = await probeMcp(
        { name: "sse-diagnostic", url: `${origin}/mcp` },
        { cwd: f.dir },
      );
      expect(result.status).toBe("ok");
      expect(result.toolCount).toBe(2);
      expect(events).toEqual(
        timing === "before"
          ? ["GET diagnostic", "GET body cancelled", "first tools", "second tools"]
          : ["first tools", "GET diagnostic", "GET body cancelled", "second tools"],
      );
    }
  },
);

test("ordinary verbs/content types/protocol headers survive while explicit HTTP secrets are redacted", async () => {
  const f = fixture();
  process.env.CODESHELL_FIXTURE_HEADER_TOKEN = "env-header-secret";
  cleanup.push(() => {
    delete process.env.CODESHELL_FIXTURE_HEADER_TOKEN;
  });
  handle = async (request) => {
    if (request.method !== "POST") return new Response(null, { status: 405 });
    const input = await request.json();
    if (input.id === undefined) return new Response(null, { status: 202 });
    return Response.json({
      jsonrpc: "2.0",
      id: input.id,
      result:
        input.method === "initialize"
          ? {
              protocolVersion: "2024-11-05",
              capabilities: { tools: {} },
              serverInfo: { name: "fixture", version: "1" },
            }
          : {
              tools: [
                {
                  name: "run_query",
                  description:
                    "run application/json 2024-11-05 auth-secret env-header-secret argument-secret credential-secret header-credential-secret",
                  inputSchema: { type: "object", properties: {} },
                },
              ],
            },
    });
  };
  const result = await probeMcp(
    {
      name: "redaction",
      url: `${origin}/mcp`,
      args: ["run", "--token", "argument-secret", "--credential=credential-secret"],
      headers: {
        "Content-Type": "application/json",
        "MCP-Protocol-Version": "2024-11-05",
        Authorization: "Bearer auth-secret",
        "X-Credential": "header-credential-secret",
      },
      envHeaders: { "X-Custom": "CODESHELL_FIXTURE_HEADER_TOKEN" },
    },
    { cwd: f.dir },
  );
  expect(result.status).toBe("ok");
  expect(result.tools?.[0]?.name).toBe("run_query");
  expect(result.tools?.[0]?.description).toContain("run application/json 2024-11-05");
  expect(JSON.stringify(result)).not.toMatch(
    /auth-secret|env-header-secret|argument-secret|credential-secret/,
  );
});
