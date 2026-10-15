import { expect, test } from "bun:test";
import type { Credential } from "@cjhyy/code-shell-core";
import { FIGMA_MCP_SERVER_URL } from "@cjhyy/code-shell-link";
import { createFigmaMcpLinkAdapter } from "./figma-mcp-link.js";
import type { HostMcpOAuthLoginOptions } from "./mcp-oauth-service.js";

function candidate(): Credential {
  return {
    id: "link-figma-mcp",
    type: "oauth",
    label: "Figma",
    secret: JSON.stringify({
      version: 1,
      accessToken: "fixture-access",
      refreshToken: "fixture-refresh",
      tokenType: "Bearer",
      issuer: "https://api.figma.com",
      resource: FIGMA_MCP_SERVER_URL,
    }),
    meta: {
      oauthProvider: "figma",
      mcpServerUrl: FIGMA_MCP_SERVER_URL,
      issuer: "https://api.figma.com",
      resource: FIGMA_MCP_SERVER_URL,
    },
  };
}
function fixture(
  options: {
    whoami?: unknown;
    resources?: boolean;
    tools?: string[];
    toolPages?: string[][];
    repeatCursor?: boolean;
  } = {},
) {
  const requests: Array<{ method: string; params?: Record<string, unknown> }> = [];
  let trustedOptions: HostMcpOAuthLoginOptions | undefined;
  const fetch = (async (input, init) => {
    const request = new Request(input, init);
    if (request.url !== FIGMA_MCP_SERVER_URL) throw new Error("Fixture refused non-MCP endpoint");
    expect(request.headers.get("authorization")).toBe("Bearer fixture-access");
    if (request.method === "GET") return new Response(null, { status: 405 });
    const call = (await request.json()) as {
      id?: string;
      method: string;
      params?: Record<string, unknown>;
    };
    requests.push(call);
    if (call.id === undefined) return new Response(null, { status: 202 });
    let result: unknown;
    if (call.method === "initialize")
      result = {
        protocolVersion: "2025-11-25",
        capabilities: { tools: {}, ...(options.resources === false ? {} : { resources: {} }) },
        serverInfo: { name: "figma-fixture", version: "1" },
      };
    else if (call.method === "tools/list") {
      const page = Number(call.params?.cursor ?? 0);
      result = {
        tools: (
          options.toolPages?.[page] ??
          options.tools ?? [
            "whoami",
            "get_metadata",
            "get_screenshot",
            "use_figma",
            "create_new_file",
          ]
        ).map((name) => ({ name, inputSchema: { type: "object" } })),
        ...(options.repeatCursor || (options.toolPages && page + 1 < options.toolPages.length)
          ? { nextCursor: options.repeatCursor ? "1" : String(page + 1) }
          : {}),
      };
    } else if (call.method === "tools/call" && call.params?.name === "whoami")
      result = {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              options.whoami ?? { email: "fixture@example.test", name: "Fixture" },
            ),
          },
        ],
      };
    else throw new Error("Connecting must not call file or write tools");
    return Response.json({ jsonrpc: "2.0", id: call.id, result });
  }) as typeof globalThis.fetch;
  const adapter = createFigmaMcpLinkAdapter({
    fetch,
    oauth: {
      async authorizeCredential(input, options) {
        expect(input).toEqual({
          source: "catalog",
          profileId: "figma-mcp",
          credentialId: "link-figma-mcp",
        });
        trustedOptions = options;
        return options.validateCredential!(candidate(), options.signal);
      },
      async revokeDetachedCredential() {
        return false;
      },
    },
    openExternal: async () => {},
  });
  return {
    adapter,
    requests,
    get trustedOptions() {
      return trustedOptions;
    },
  };
}

test("connect verifies account and discovers only explicit read capabilities without reading files", async () => {
  const f = fixture();
  const credential = await f.adapter.authorize({
    id: "link-figma-mcp",
    label: "My Figma",
    previous: null,
    signal: new AbortController().signal,
    onAuthorizationUrl: async () => {},
  });
  expect(f.trustedOptions?.callbackTimeoutMs).toBe(600_000);
  expect(credential.type).toBe("oauth");
  expect(credential.label).toBe("My Figma");
  expect(credential.meta).toMatchObject({
    linkProvider: "figma",
    linkConnectionMethod: "mcp",
    linkExecutionBackend: "mcp",
    linkExecutionRuntime: "local",
    linkAuthSource: "mcp-oauth",
    agentExposable: false,
    linkAccountId: "fixture@example.test",
  });
  expect(credential.meta?.linkCapabilityIds).toEqual([
    "figma.get_metadata",
    "figma.get_screenshot",
    "figma.list_resources",
    "figma.read_resource",
  ]);
  expect(
    f.requests.find((request) => request.method === "initialize")?.params?.clientInfo,
  ).toMatchObject({ name: "CodeShell" });
  expect(
    f.requests
      .filter((request) => request.method === "tools/call")
      .map((request) => request.params?.name),
  ).toEqual(["whoami"]);
});

test("unadvertised resource support and unrecognized tools never expand the grant", async () => {
  const f = fixture({
    resources: false,
    tools: ["whoami", "get_metadata", "unknown_future_read", "use_figma"],
  });
  const credential = await f.adapter.authorize({
    id: "link-figma-mcp",
    label: "My Figma",
    previous: null,
    signal: new AbortController().signal,
    onAuthorizationUrl: async () => {},
  });
  expect(credential.meta?.linkCapabilityIds).toEqual(["figma.get_metadata"]);
});

test("connection verification consumes bounded tool pagination before granting reads", async () => {
  const f = fixture({
    resources: false,
    toolPages: [["get_metadata"], ["whoami", "get_screenshot"]],
  });
  const credential = await f.adapter.authorize({
    id: "link-figma-mcp",
    label: "My Figma",
    previous: null,
    signal: new AbortController().signal,
    onAuthorizationUrl: async () => {},
  });
  expect(credential.meta?.linkCapabilityIds).toEqual([
    "figma.get_metadata",
    "figma.get_screenshot",
  ]);
  expect(
    f.requests
      .filter((request) => request.method === "tools/list")
      .map((request) => request.params?.cursor),
  ).toEqual([undefined, "1"]);

  const repeated = fixture({ repeatCursor: true });
  await expect(
    repeated.adapter.authorize({
      id: "link-figma-mcp",
      label: "My Figma",
      previous: null,
      signal: new AbortController().signal,
      onAuthorizationUrl: async () => {},
    }),
  ).rejects.toThrow("pagination is invalid");
  expect(repeated.requests.filter((request) => request.method === "tools/call")).toEqual([]);
});

test("missing account identity fails connection verification", async () => {
  const f = fixture({ whoami: { name: "Unbound display name" } });
  await expect(
    f.adapter.authorize({
      id: "link-figma-mcp",
      label: "My Figma",
      previous: null,
      signal: new AbortController().signal,
      onAuthorizationUrl: async () => {},
    }),
  ).rejects.toThrow("identity is unavailable");
});

test("only the fixed official authorization page may launch", async () => {
  const f = fixture();
  await expect(
    f.adapter.openAuthorizationUrl("https://attacker.example/oauth/mcp"),
  ).rejects.toThrow();
  await expect(
    f.adapter.openAuthorizationUrl("https://www.figma.com/oauth/mcp#secret"),
  ).rejects.toThrow();
});
