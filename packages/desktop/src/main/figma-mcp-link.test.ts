import { expect, test } from "bun:test";
import type { Credential } from "@cjhyy/code-shell-core";
import { FIGMA_MCP_SERVER_URL } from "@cjhyy/code-shell-link";
import { createFigmaMcpLinkAdapter } from "./figma-mcp-link.js";
import { McpOAuthServiceError, type HostMcpOAuthLoginOptions } from "./mcp-oauth-service.js";
import { HostLinkOAuthError } from "@cjhyy/code-shell-server/links";

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
    whoamiResult?: unknown;
    failMethod?: string;
    toolOutputSchema?: Record<string, unknown>;
    oauthError?: McpOAuthServiceError;
  } = {},
) {
  const requests: Array<{ method: string; params?: Record<string, unknown> }> = [];
  const shapes: Record<string, unknown>[] = [];
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
    if (call.method === options.failMethod)
      return Response.json({ secret: "provider-body-must-stay-private" }, { status: 503 });
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
        ).map((name) => ({
          name,
          inputSchema: { type: "object" },
          ...(name === "whoami" && options.toolOutputSchema
            ? { outputSchema: options.toolOutputSchema }
            : {}),
        })),
        ...(options.repeatCursor || (options.toolPages && page + 1 < options.toolPages.length)
          ? { nextCursor: options.repeatCursor ? "1" : String(page + 1) }
          : {}),
      };
    } else if (call.method === "tools/call" && call.params?.name === "whoami")
      result = options.whoamiResult ?? {
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
    onAccountShape: (shape) => shapes.push(shape),
    fetch,
    oauth: {
      async authorizeCredential(input, loginOptions) {
        if (options.oauthError) throw options.oauthError;
        expect(input).toEqual({
          source: "catalog",
          profileId: "figma-mcp",
          credentialId: "link-figma-mcp",
        });
        trustedOptions = loginOptions;
        return loginOptions.validateCredential!(candidate(), loginOptions.signal);
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
    shapes,
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
  ).rejects.toMatchObject({ verificationStage: "tool_discovery", reason: "invalid_pagination" });
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
  ).rejects.toMatchObject({
    verificationStage: "account_verification",
    reason: "account_identity_unavailable",
  });
});

test("official account fields survive separate JSON, explanatory text and empty structured content", async () => {
  const account = {
    handle: "Fixture user",
    email: "fixture@example.test",
    plans: [{ seat: "Dev", tier: "pro" }],
  };
  for (const result of [
    {
      content: [
        { type: "text", text: JSON.stringify(account) },
        { type: "text", text: "Account plans are listed above." },
      ],
    },
    {
      structuredContent: {},
      content: [{ type: "text", text: `\`\`\`json\n${JSON.stringify(account)}\n\`\`\`` }],
    },
    { structuredContent: { user: account }, content: [] },
  ]) {
    const f = fixture({ whoamiResult: result });
    const value = await f.adapter.authorize({
      id: "link-figma-mcp",
      label: "Figma",
      previous: null,
      signal: new AbortController().signal,
      onAuthorizationUrl: async () => {},
    });
    expect(value.meta?.linkAccountId).toBe("fixture@example.test");
    expect(value.meta?.linkAccountLabel).toBe("Fixture user (fixture@example.test)");
    expect(JSON.stringify(f.shapes)).not.toContain("fixture@example.test");
    expect(JSON.stringify(f.shapes)).not.toContain("Fixture user");
    expect(
      f.requests
        .filter((request) => request.method === "tools/call")
        .map((request) => request.params?.name),
    ).toEqual(["whoami"]);
  }
});

test("verification reports fixed stages and HTTP status without provider details", async () => {
  for (const [method, stage] of [
    ["initialize", "mcp_initialize"],
    ["tools/list", "tool_discovery"],
    ["tools/call", "account_verification"],
  ]) {
    const f = fixture({ failMethod: method });
    let failure: unknown;
    try {
      await f.adapter.authorize({
        id: "link-figma-mcp",
        label: "Figma",
        previous: null,
        signal: new AbortController().signal,
        onAuthorizationUrl: async () => {},
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ verificationStage: stage, reason: "http_error", status: 503 });
    expect(String(failure)).not.toContain("provider-body-must-stay-private");
    expect(JSON.stringify(failure)).not.toContain("fixture-access");
  }
});

test("SDK structured output failure remains an account protocol failure", async () => {
  const f = fixture({
    toolOutputSchema: {
      type: "object",
      required: ["email"],
      properties: { email: { type: "string" } },
    },
  });
  await expect(
    f.adapter.authorize({
      id: "link-figma-mcp",
      label: "Figma",
      previous: null,
      signal: new AbortController().signal,
      onAuthorizationUrl: async () => {},
    }),
  ).rejects.toMatchObject({ verificationStage: "account_verification", reason: "protocol_error" });
});

test("normalized OAuth verification errors become reviewed Host authorization failures", async () => {
  const f = fixture({
    oauthError: new McpOAuthServiceError(
      "server_error",
      "MCP connection verification failed",
      "credential_verification",
      503,
      "account_verification",
      "http_error",
    ),
  });
  let failure: unknown;
  try {
    await f.adapter.authorize({
      id: "link-figma-mcp",
      label: "Figma",
      previous: null,
      signal: new AbortController().signal,
      onAuthorizationUrl: async () => {},
    });
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(HostLinkOAuthError);
  expect((failure as HostLinkOAuthError).failure).toEqual({
    code: "server_error",
    stage: "credential_verification",
    verificationStage: "account_verification",
    reason: "http_error",
    httpStatus: 503,
  });
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
