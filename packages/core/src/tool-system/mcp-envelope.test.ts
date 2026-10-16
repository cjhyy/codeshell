import { describe, expect, test } from "bun:test";
import { MCPManager, createMcpAuthenticatedFetch } from "./mcp-manager.js";
import { ToolRegistry } from "./registry.js";
import type { CredentialAccess } from "../credentials/access.js";
import { MAX_MCP_RESULT_BYTES } from "./mcp-results.js";

function fakeManager(client: object) {
  const manager = new MCPManager(new ToolRegistry({ builtinTools: [] }), {
    defaultInstance: false,
  });
  const connection = {
    serverName: "srv",
    client,
    tools: new Map([["read", { name: "read", inputSchema: { type: "object" } }]]),
  };
  (manager as any).connections.set("srv", connection);
  return { manager, connection };
}

describe("MCP typed envelopes", () => {
  test("keeps every tool content kind, structuredContent, metadata and isError", async () => {
    const envelope = {
      content: [
        { type: "text", text: "context" },
        {
          type: "resource_link",
          uri: "file://chosen/context",
          name: "context",
          mimeType: "text/plain",
        },
        {
          type: "resource",
          resource: { uri: "file://chosen/image", mimeType: "image/png", blob: "YWJj" },
        },
        { type: "audio", data: "YWJj", mimeType: "audio/wav" },
      ],
      structuredContent: { layout: { rows: [1, 2] } },
      _meta: { trace: "fixture" },
      isError: true,
    };
    const { manager } = fakeManager({ callTool: async () => envelope });
    expect(await manager.callToolEnvelope("srv", "read", {})).toEqual(envelope);
    await expect(manager.callToolResult("srv", "read", {})).rejects.toThrow("structuredContent");
    await expect(manager.callToolEnvelope("srv", "unlisted", {})).rejects.toThrow("not available");
  });

  test("explicit pages preserve cursors/templates and do not eagerly load later pages", async () => {
    const seen: unknown[] = [];
    const { manager } = fakeManager({
      listResources: async (params: { cursor?: string }) => {
        seen.push(params);
        return params.cursor
          ? { resources: [{ uri: "test://two", name: "Two", mimeType: "image/png" }] }
          : {
              resources: [{ uri: "test://one", name: "One", annotations: { priority: 0.5 } }],
              nextCursor: "second",
              _meta: { page: 1 },
            };
      },
      listResourceTemplates: async (params: object) => ({
        resourceTemplates: [
          { uriTemplate: "test://file/{path}", name: "files", mimeType: "text/plain" },
        ],
        nextCursor: "templates",
        _meta: params,
      }),
      readResource: async ({ uri }: { uri: string }) => ({
        contents: [
          {
            uri,
            mimeType: "application/octet-stream",
            blob: "YWJj",
            _meta: { encoding: "fixture" },
          },
        ],
      }),
    });
    expect(await manager.listResourcesPage("srv")).toMatchObject({
      nextCursor: "second",
      _meta: { page: 1 },
    });
    expect(seen).toHaveLength(1);
    expect(await manager.listResourcesPage("srv", { cursor: "second" })).toMatchObject({
      resources: [{ mimeType: "image/png" }],
    });
    expect(await manager.listResourceTemplatesPage("srv", { cursor: "next" })).toMatchObject({
      nextCursor: "templates",
      resourceTemplates: [{ uriTemplate: "test://file/{path}" }],
      _meta: { cursor: "next" },
    });
    expect(await manager.readResourceResult("srv", "test://blob")).toEqual({
      contents: [
        {
          uri: "test://blob",
          mimeType: "application/octet-stream",
          blob: "YWJj",
          _meta: { encoding: "fixture" },
        },
      ],
    });
    await expect(manager.readResource("srv", "test://blob")).rejects.toThrow(
      "use readResourceResult",
    );
    expect((await manager.listResources("srv")).map((item) => item.uri)).toEqual([
      "test://one",
      "test://two",
    ]);
  });

  test("rejects malformed responses, endless pagination and oversize results", async () => {
    const { manager } = fakeManager({
      listResources: async () => ({ resources: [], nextCursor: "repeat" }),
      readResource: async () => ({ contents: [{ uri: "test://missing" }] }),
      callTool: async () => ({
        content: [],
        structuredContent: { value: "x".repeat(MAX_MCP_RESULT_BYTES) },
      }),
    });
    await expect(manager.listResources("srv")).rejects.toThrow("bounded cursor traversal");
    await expect(manager.readResourceResult("srv", "test://missing")).rejects.toThrow(
      "Invalid MCP resource contents",
    );
    await expect(manager.callToolEnvelope("srv", "read", {})).rejects.toMatchObject({
      code: "response_too_large",
    });
    await expect(manager.listResourcesPage("srv", { cursor: "" })).rejects.toThrow("cursor");
  });

  test("final cancellation and connection gates reject late results", async () => {
    let finish!: (result: object) => void;
    const { manager, connection } = fakeManager({
      callTool: () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    });
    const controller = new AbortController();
    const pending = manager.callToolEnvelope("srv", "read", {}, controller.signal);
    await Promise.resolve();
    controller.abort();
    finish({ content: [] });
    await expect(pending).rejects.toThrow();
    const replaced = manager.callToolEnvelope("srv", "read", {});
    await Promise.resolve();
    (manager as any).connections.set("srv", { ...connection });
    finish({ content: [] });
    await expect(replaced).rejects.toThrow("cancel");
  });
});

describe("MCP HTTP credential boundary", () => {
  const endpoint = "https://mcp.example/mcp";
  function access(
    resolve: () => Promise<{ accessToken: string }> = async () => ({ accessToken: "fixture" }),
  ): CredentialAccess {
    return {
      listMasked: () => [],
      envExposures: () => ({}),
      resolveMeta: () => ({
        id: "oauth",
        type: "oauth",
        label: "OAuth",
        hasSecret: true,
        meta: {
          mcpServerUrl: endpoint,
          resource: "https://mcp.example/",
          issuer: "https://auth.example/",
        },
      }),
      resolveOAuthAccess: resolve,
    };
  }
  test("rejects a different request target before resolving or sending credentials", async () => {
    let resolutions = 0,
      sends = 0;
    const fetcher = createMcpAuthenticatedFetch(
      "srv",
      { name: "srv", url: endpoint, credentialRef: "oauth" },
      access(async () => {
        resolutions++;
        return { accessToken: "fixture" };
      }),
      (async () => {
        sends++;
        return new Response("");
      }) as typeof fetch,
    );
    for (const target of [
      "https://evil.example/mcp",
      "https://mcp.example/other",
      "https://mcp.example/mcp?redirect=1",
    ])
      await expect(fetcher(target)).rejects.toThrow("target");
    expect(resolutions).toBe(0);
    expect(sends).toBe(0);
  });
  test("does not follow redirects and rechecks credential revocation after token resolution", async () => {
    const fetcher = createMcpAuthenticatedFetch(
      "srv",
      { name: "srv", url: endpoint, credentialRef: "oauth" },
      access(),
      (async (request: Request) => {
        expect(request.redirect).toBe("error");
        return new Response("", { status: 307, headers: { Location: "https://evil.example/mcp" } });
      }) as typeof fetch,
    );
    await expect(fetcher(endpoint)).rejects.toThrow("redirects");
    let revoked = false,
      sends = 0;
    const ownerAccess = access(async () => {
      revoked = true;
      return { accessToken: "fixture" };
    });
    const original = ownerAccess.resolveMeta;
    ownerAccess.resolveMeta = (...args) => (revoked ? undefined : original(...args));
    const revokedFetch = createMcpAuthenticatedFetch(
      "srv",
      { name: "srv", url: endpoint, credentialRef: "oauth" },
      ownerAccess,
      (async () => {
        sends++;
        return new Response("");
      }) as typeof fetch,
    );
    await expect(revokedFetch(endpoint)).rejects.toThrow("no longer available");
    expect(sends).toBe(0);
  });
});

test("isolated MCP manager uses its own credential access and paginates real local protocol", async () => {
  const defaultManager = new MCPManager(new ToolRegistry({ builtinTools: [] }));
  const calls: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      expect(request.headers.get("Authorization")).toBe("Bearer local-fixture");
      if (request.method !== "POST") return new Response("", { status: 405 });
      const message = (await request.json()) as any;
      calls.push(message.method);
      if (message.id === undefined) return new Response(null, { status: 202 });
      let result: object;
      if (message.method === "initialize")
        result = {
          protocolVersion: message.params.protocolVersion,
          capabilities:
            new URL(request.url).pathname === "/resources"
              ? { resources: {} }
              : { tools: {}, resources: {} },
          serverInfo: { name: "local-fixture", version: "1" },
        };
      else if (message.method === "tools/list")
        result = message.params?.cursor
          ? { tools: [{ name: "second", inputSchema: { type: "object" } }] }
          : { tools: [{ name: "read", inputSchema: { type: "object" } }], nextCursor: "second" };
      else if (message.method === "tools/call")
        result = {
          content: [{ type: "resource_link", uri: "file://selected/context", name: "context" }],
          structuredContent: { ok: true },
        };
      else if (message.method === "resources/list")
        result = {
          resources: [{ uri: "file://selected/context", name: "context", mimeType: "text/plain" }],
          nextCursor: "resource-next",
        };
      else if (message.method === "resources/read")
        result = { contents: [{ uri: message.params.uri, mimeType: "image/png", blob: "YWJj" }] };
      else if (message.method === "resources/templates/list")
        result = { resourceTemplates: [{ name: "files", uriTemplate: "file://selected/{path}" }] };
      else throw new Error(`Unexpected method ${message.method}`);
      return Response.json({ jsonrpc: "2.0", id: message.id, result });
    },
  });
  const registry = new ToolRegistry({ builtinTools: [] });
  const manager = new MCPManager(registry, {
    defaultInstance: false,
    credentialAccess: {
      listMasked: () => [],
      envExposures: () => ({}),
      resolveMeta: () => ({ id: "fixture", label: "Fixture", type: "token", hasSecret: true }),
      resolveValue: async () => "local-fixture",
    },
  });
  try {
    expect(MCPManager.getInstance()).toBe(defaultManager);
    await manager.connect("local", {
      name: "local",
      url: `http://127.0.0.1:${server.port}/mcp`,
      credentialRef: "fixture",
    });
    expect(registry.hasTool("mcp_local_second")).toBe(true);
    expect(await manager.callToolEnvelope("local", "read", {})).toMatchObject({
      structuredContent: { ok: true },
      content: [{ type: "resource_link" }],
    });
    expect(await manager.listResourcesPage("local")).toMatchObject({ nextCursor: "resource-next" });
    expect(await manager.listResourceTemplatesPage("local")).toMatchObject({
      resourceTemplates: [{ uriTemplate: "file://selected/{path}" }],
    });
    expect(await manager.readResourceResult("local", "file://selected/context")).toMatchObject({
      contents: [{ mimeType: "image/png", blob: "YWJj" }],
    });
    expect(calls.filter((name) => name === "tools/list")).toHaveLength(2);
    expect(calls.filter((name) => name === "resources/list")).toHaveLength(1);
    await manager.connect("resources", {
      name: "resources",
      url: `http://127.0.0.1:${server.port}/resources`,
      credentialRef: "fixture",
    });
    expect(await manager.listResourcesPage("resources")).toMatchObject({
      nextCursor: "resource-next",
    });
    expect(calls.filter((name) => name === "tools/list")).toHaveLength(2);
  } finally {
    await manager.disconnectAll();
    server.stop(true);
  }
});
