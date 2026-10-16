import { afterEach, describe, expect, test } from "bun:test";
import { FIGMA_MCP_ACTION_IDS, FIGMA_MCP_SERVER_URL } from "@cjhyy/code-shell-link";
import { CredentialStore } from "../credentials/store.js";
import type { Credential } from "../credentials/types.js";
import {
  setDefaultCredentialAccess,
  createIpcCredentialAccess,
  type CredentialAccess,
  type CredentialMetadata,
} from "../credentials/access.js";
import type { ToolContext } from "../tool-system/context.js";
import {
  executeFigmaMcpLinkAction,
  type McpLinkActionRequest,
  type McpLinkActionOptions,
} from "./figma-mcp.js";
import { assertFigmaMakeResourceUri, figmaMcpParameters } from "./figma-mcp-params.js";
import { allowsLinkAction, linkAuthoritySnapshot } from "./authority.js";
import { linkActionTool } from "./link-action-tool.js";
import { createInProcessTransport } from "../protocol/transport.js";

let nextId = 0;
function credential(): Credential {
  return {
    id: `figma-mcp-fixture-${nextId++}`,
    type: "oauth",
    label: "Figma MCP",
    secret: JSON.stringify({
      version: 1,
      accessToken: "synthetic-access",
      refreshToken: "synthetic-refresh",
      expiresAt: "2099-01-01T00:00:00Z",
      tokenEndpoint: "https://api.figma.com/v1/oauth/token",
      clientId: "fixture",
      resource: FIGMA_MCP_SERVER_URL,
      issuer: "https://api.figma.com",
      scope: "mcp:connect",
    }),
    meta: {
      linkProvider: "figma",
      linkExecutionBackend: "mcp",
      linkAuthSource: "mcp-oauth",
      linkExecutionRuntime: "local",
      linkConnectionMethod: "mcp",
      mcpServerUrl: FIGMA_MCP_SERVER_URL,
      resource: FIGMA_MCP_SERVER_URL,
      issuer: "https://api.figma.com",
      linkAccountId: "account-one",
      linkAccountLabel: "Designer",
      linkLastVerifiedAt: "2026-10-15T00:00:00Z",
      linkCapabilityIds: FIGMA_MCP_ACTION_IDS.map((action) => `figma.${action}`),
      agentExposable: false,
    },
  };
}

class MemoryStore extends CredentialStore {
  entries = new Map<string, Credential>();
  override resolve(id: string): Credential | undefined {
    const value = this.entries.get(id);
    return value ? structuredClone(value) : undefined;
  }
  override list(): Credential[] {
    return [...this.entries.values()].map((value) => structuredClone(value));
  }
}

function fixture() {
  const value = credential();
  const store = new MemoryStore();
  store.entries.set(value.id, value);
  const calls: Array<{ action: string; args?: Record<string, unknown>; uri?: string }> = [];
  let connections = 0;
  let closed = 0;
  let outcome: Record<string, unknown> = {
    content: [{ type: "text", text: '<frame id="1:2" />' }],
  };
  let afterCall: (() => void) | undefined;
  const options: McpLinkActionOptions = {
    store,
    userStore: store,
    resolveOAuthAccess: async (input) => {
      expect(input.id).toBe(value.id);
      expect(input.serverUrl).toBe(FIGMA_MCP_SERVER_URL);
      return { accessToken: "synthetic-access" };
    },
    createManager: (access) => ({
      async connect(_name, config) {
        connections++;
        expect(config.url).toBe(FIGMA_MCP_SERVER_URL);
        await access.resolveOAuthAccess!({
          id: value.id,
          serverUrl: FIGMA_MCP_SERVER_URL,
          scope: "full",
        });
      },
      async callToolEnvelope(_server, action, args) {
        calls.push({ action, args });
        afterCall?.();
        return structuredClone(outcome);
      },
      async listResourcesPage() {
        calls.push({ action: "list_resources" });
        return {
          resources: [
            {
              uri: "file://figma/make/source/MakeOne/src/App.tsx",
              name: "App.tsx",
              mimeType: "text/typescript",
            },
          ],
          nextCursor: "next-page",
        };
      },
      async readResourceResult(_server, uri) {
        calls.push({ action: "read_resource", uri });
        return {
          contents: [{ uri, mimeType: "text/typescript", text: "export const App = () => null;" }],
        };
      },
      async disconnectAll() {
        closed++;
      },
    }),
  };
  const run = (
    action: string,
    params: Record<string, unknown>,
    overrides: Partial<McpLinkActionRequest> = {},
  ) =>
    executeFigmaMcpLinkAction(
      {
        id: value.id,
        scope: "full",
        accountId: value.meta!.linkAccountId!,
        verifiedAt: value.meta!.linkLastVerifiedAt!,
        action,
        params,
        ...overrides,
      },
      options,
    );
  return {
    value,
    store,
    calls,
    options,
    run,
    connections: () => connections,
    closed: () => closed,
    setOutcome: (value: Record<string, unknown>) => {
      outcome = value;
    },
    after: (callback: () => void) => {
      afterCall = callback;
    },
  };
}

afterEach(() => setDefaultCredentialAccess(null));

describe("Figma MCP on-demand target and resource boundaries", () => {
  test("detailed Design reads require selected nodes; Make first discovers a manifest", () => {
    expect(figmaMcpParameters("get_metadata", { file_key: "FileOne" }).args).toEqual({
      fileKey: "FileOne",
    });
    expect(() =>
      figmaMcpParameters("get_design_context", {
        file_url_or_key: "https://figma.com/design/FileOne/Design",
      }),
    ).toThrow("Select a node_id");
    expect(
      figmaMcpParameters("get_design_context", {
        file_url_or_key: "https://figma.com/design/FileOne/Design?node-id=1-2",
      }).args,
    ).toEqual({ fileKey: "FileOne", nodeId: "1:2" });
    expect(
      figmaMcpParameters("get_design_context", {
        file_url_or_key: "https://figma.com/make/MakeOne/Prototype",
      }).args,
    ).toEqual({ fileKey: "MakeOne", nodeId: "0:1" });
    expect(() =>
      figmaMcpParameters("get_design_context", { file_key: "FileOne", node_id: "1:2", full: true }),
    ).toThrow("Unsupported");
    expect(() =>
      figmaMcpParameters("get_metadata", {
        file_url_or_key: "https://figma.com.evil.test/design/FileOne",
      }),
    ).toThrow("official HTTPS");
    expect(() =>
      figmaMcpParameters("get_metadata", {
        file_url_or_key: "https://figma.com/design/FileOne?node-id=1-2",
        node_id: "3:4",
      }),
    ).toThrow("conflicts");
  });
  test("source URIs cannot select local files, other Make files, or arbitrary HTTPS", () => {
    expect(
      assertFigmaMakeResourceUri("file://figma/make/source/MakeOne/src/App.tsx", "MakeOne"),
    ).toContain("App.tsx");
    for (const uri of [
      "file:///etc/passwd",
      "https://example.test/source",
      "file://figma/make/source/OtherOne/src/App.tsx",
      "file://figma/make/source/MakeOne/src%2Fsecret",
      "file://figma/make/source/MakeOne/src/App.tsx?token=x",
      "file://figma/make/source/OtherOne/../MakeOne/src/App.tsx",
      "file://figma/make/source/OtherOne/%2e%2e/MakeOne/src/App.tsx",
    ])
      expect(() => assertFigmaMakeResourceUri(uri, "MakeOne")).toThrow();
  });
  test("a node read preserves the complete result without other reads or token export", async () => {
    const f = fixture();
    f.setOutcome({
      content: [{ type: "text", text: "node content" }],
      structuredContent: { layout: "auto", components: ["Button"] },
      _meta: { note: "fixture" },
    });
    const result = (await f.run("get_design_context", {
      file_key: "FileOne",
      node_id: "1:2",
    })) as any;
    expect(result.structuredContent).toEqual({ layout: "auto", components: ["Button"] });
    expect(f.calls).toEqual([
      { action: "get_design_context", args: { fileKey: "FileOne", nodeId: "1:2" } },
    ]);
    expect(f.closed()).toBe(1);
    expect(JSON.stringify(result)).not.toContain("synthetic-access");
  });
  test("Make manifest discovery does not read sources; selected resources keep MIME and text", async () => {
    const f = fixture();
    const uri = "file://figma/make/source/MakeOne/src/App.tsx";
    f.setOutcome({
      content: [
        { type: "resource_link", uri, name: "App.tsx", mimeType: "text/typescript" },
        {
          type: "resource_link",
          uri: "file://figma/make/source/OtherOne/private.ts",
          name: "Other",
        },
      ],
    });
    await f.run("get_design_context", {
      file_url_or_key: "https://figma.com/make/MakeOne/Prototype",
    });
    expect(f.calls).toHaveLength(1);
    const result = (await f.run("read_resource", {
      file_url_or_key: "https://figma.com/make/MakeOne/Prototype",
      uri,
    })) as any;
    expect(result.contents).toEqual([
      { uri, mimeType: "text/typescript", text: "export const App = () => null;" },
    ]);
    expect(f.calls[1]).toEqual({ action: "read_resource", uri });
  });
  test("resource reads reject guessed URIs and manifests from a previous grant", async () => {
    const f = fixture();
    const params = {
      file_url_or_key: "https://figma.com/make/MakeOne/Prototype",
      uri: "file://figma/make/source/MakeOne/src/App.tsx",
    };
    await expect(f.run("read_resource", params)).rejects.toMatchObject({
      code: "resource_not_discovered",
    });
    expect(f.connections()).toBe(0);
    await f.run("list_resources", { file_url_or_key: params.file_url_or_key });
    f.value.meta!.linkCapabilityIds = ["figma.read_resource"];
    f.store.entries.set(f.value.id, f.value);
    await expect(f.run("read_resource", params)).rejects.toMatchObject({
      code: "resource_not_discovered",
    });
  });
  test("late completion is rejected after cancellation or a connection change", async () => {
    const f = fixture();
    const abort = new AbortController();
    f.options.signal = abort.signal;
    f.after(() => abort.abort());
    await expect(f.run("get_metadata", { file_key: "FileOne" })).rejects.toMatchObject({
      name: "AbortError",
    });
    const next = fixture();
    next.after(() => next.store.entries.delete(next.value.id));
    await expect(next.run("get_metadata", { file_key: "FileOne" })).rejects.toMatchObject({
      code: "changed",
    });
  });
  test("project scope and same-ID project account overrides cannot borrow the user token", async () => {
    const f = fixture();
    await expect(
      f.run("get_metadata", { file_key: "FileOne" }, { scope: "project" }),
    ).rejects.toMatchObject({ code: "forbidden" });
    const userStore = new MemoryStore();
    const userAccount = structuredClone(f.value);
    userAccount.meta!.linkAccountId = "other-account";
    userStore.entries.set(f.value.id, userAccount);
    f.options.userStore = userStore;
    await expect(f.run("get_metadata", { file_key: "FileOne" })).rejects.toMatchObject({
      code: "changed",
    });
    expect(f.connections()).toBe(0);
  });
  test("same OAuth scope set survives token refresh while changed scope invalidates authority", async () => {
    const base = { id: "a", type: "oauth", hasSecret: true } as CredentialMetadata;
    const before = linkAuthoritySnapshot({
      ...base,
      oauthStatus: { state: "valid", scope: "b a" },
    });
    expect(
      linkAuthoritySnapshot({
        ...base,
        oauthStatus: {
          state: "valid",
          scope: "a b",
          scopes: ["a", "b"],
        },
      }),
    ).toBe(before);
    expect(
      linkAuthoritySnapshot({ ...base, oauthStatus: { state: "valid", scopes: ["b", "a", "a"] } }),
    ).toBe(before);
    expect(
      linkAuthoritySnapshot({ ...base, oauthStatus: { state: "valid", scope: "a" } }),
    ).not.toBe(before);
    const f = fixture();
    f.after(() => {
      const saved = f.store.entries.get(f.value.id)!;
      saved.secret = JSON.stringify({ ...JSON.parse(saved.secret!), scopes: ["mcp:connect"] });
    });
    await expect(f.run("get_metadata", { file_key: "FileOne" })).resolves.toMatchObject({
      backend: "mcp",
    });
  });
  test("permanent refresh failure requests reconnect; a network failure does not", async () => {
    for (const permanent of [true, false]) {
      const f = fixture();
      f.options.resolveOAuthAccess = async () => {
        if (permanent) f.store.entries.get(f.value.id)!.meta!.linkOAuthState = "reconnect";
        throw new Error("synthetic refresh failure");
      };
      await expect(f.run("get_metadata", { file_key: "FileOne" })).rejects.toMatchObject({
        code: permanent ? "reconnect" : "provider_error",
      });
    }
  });
  test("untyped metadata and read responses cannot admit additional Make resources", async () => {
    const f = fixture();
    const uri = "file://figma/make/source/MakeOne/src/Hidden.tsx";
    const file_url_or_key = "https://figma.com/make/MakeOne/Prototype";
    f.setOutcome({ content: [{ type: "text", text: "manifest" }], _meta: { uri } });
    await f.run("get_design_context", { file_url_or_key });
    await expect(f.run("read_resource", { file_url_or_key, uri })).rejects.toMatchObject({
      code: "resource_not_discovered",
    });
    await f.run("list_resources", { file_url_or_key });
    const create = f.options.createManager!;
    f.options.createManager = (access) => ({
      ...create(access),
      async readResourceResult(_server, selected) {
        return { contents: [{ uri: selected, text: "source" }], _meta: { uri } };
      },
    });
    await f.run("read_resource", {
      file_url_or_key,
      uri: "file://figma/make/source/MakeOne/src/App.tsx",
    });
    await expect(f.run("read_resource", { file_url_or_key, uri })).rejects.toMatchObject({
      code: "resource_not_discovered",
    });
  });
  test("response overflow errors instead of slicing; upstream errors remain external data", async () => {
    const f = fixture();
    f.setOutcome({ content: [{ type: "text", text: "x".repeat(8 * 1024 * 1024) }] });
    await expect(f.run("get_metadata", { file_key: "FileOne" })).rejects.toMatchObject({
      code: "response_too_large",
    });
    const rejected = fixture();
    rejected.setOutcome({
      isError: true,
      content: [{ type: "text", text: "File not accessible" }],
    });
    expect(await rejected.run("get_metadata", { file_key: "FileOne" })).toMatchObject({
      isError: true,
    });
  });
  test("API authorization cannot grant MCP, and MCP cannot execute REST or writes", async () => {
    const f = fixture();
    expect(
      allowsLinkAction(
        {
          type: "link",
          meta: { linkProvider: "figma", linkCapabilityIds: ["figma.get_design_context"] },
        } as CredentialMetadata,
        "figma",
        "get_design_context",
      ),
    ).toBe(false);
    expect(
      allowsLinkAction(
        { type: "oauth", meta: f.value.meta } as CredentialMetadata,
        "figma",
        "get_file",
      ),
    ).toBe(false);
    await expect(f.run("use_figma", { file_key: "FileOne" })).rejects.toMatchObject({
      code: "invalid_request",
    });
    expect(f.connections()).toBe(0);
  });
});

describe("Figma Link channel routing", () => {
  const ctx = { cwd: "/repo", signal: new AbortController().signal } as ToolContext;
  function access(
    credentials: CredentialMetadata[],
    execute?: CredentialAccess["executeMcpLinkAction"],
  ): CredentialAccess {
    return {
      listMasked: () => credentials,
      resolveMeta: (_cwd, id) => credentials.find((value) => value.id === id),
      envExposures: () => ({}),
      executeMcpLinkAction: execute,
      resolveValue: async () => {
        throw new Error("No raw token export");
      },
    };
  }
  const publicCredential = (): CredentialMetadata =>
    ({
      ...credential(),
      secret: undefined,
      hasSecret: true,
      oauthStatus: { state: "valid" },
    }) as CredentialMetadata;
  test("missing MCP requests authorization without sending a request or using API credentials", async () => {
    const api: CredentialMetadata = {
      id: "figma-api",
      type: "link",
      label: "API",
      hasSecret: true,
      meta: {
        linkProvider: "figma",
        linkExecutionRuntime: "local",
        linkCapabilityIds: ["figma.get_file"],
      },
    };
    setDefaultCredentialAccess(access([api]));
    expect(
      JSON.parse(
        await linkActionTool(
          {
            provider: "figma",
            action: "get_design_context",
            params: { file_url_or_key: "https://figma.com/design/FileOne/Design?node-id=1-2" },
          },
          ctx,
        ),
      ),
    ).toMatchObject({
      kind: "authorization_required",
      backend: "mcp",
      action: "get_design_context",
    });
  });
  test("API and MCP connections are selected by action; multiple MCP accounts require selection", async () => {
    const mcp = publicCredential();
    const api: CredentialMetadata = {
      id: "figma-api",
      type: "link",
      label: "API",
      hasSecret: true,
      meta: {
        linkProvider: "figma",
        linkExecutionRuntime: "local",
        linkCapabilityIds: ["figma.get_file"],
      },
    };
    let invoked = 0;
    setDefaultCredentialAccess(
      access([api, mcp], async (request) => {
        invoked++;
        expect(request.id).toBe(mcp.id);
        return { content: [{ type: "text", text: "metadata" }] };
      }),
    );
    expect(
      JSON.parse(
        await linkActionTool(
          { provider: "figma", action: "get_metadata", params: { file_key: "FileOne" } },
          ctx,
        ),
      ),
    ).toMatchObject({ kind: "action_result", backend: "mcp", connectionId: mcp.id });
    expect(invoked).toBe(1);
    const second = publicCredential();
    setDefaultCredentialAccess(access([mcp, second]));
    expect(
      JSON.parse(
        await linkActionTool(
          { provider: "figma", action: "get_metadata", params: { file_key: "FileOne" } },
          ctx,
        ),
      ).kind,
    ).toBe("connection_required");
  });
  test("MCP tool isError does not consume an authorization request as a successful read", async () => {
    const mcp = publicCredential();
    setDefaultCredentialAccess(
      access([mcp], async () => ({
        isError: true,
        content: [{ type: "text", text: "No access" }],
      })),
    );
    expect(
      JSON.parse(
        await linkActionTool(
          { provider: "figma", action: "get_metadata", params: { file_key: "FileOne" } },
          ctx,
        ),
      ),
    ).toMatchObject({
      kind: "error",
      backend: "mcp",
      code: "provider_rejected",
      untrustedExternalContent: true,
    });
  });
  test("a reconnect snapshot preceding the Host error recovers authorization, except after task cancellation", async () => {
    for (const cancelTask of [false, true]) {
      const [host, worker] = createInProcessTransport();
      const mcp = publicCredential();
      const access = createIpcCredentialAccess(worker);
      setDefaultCredentialAccess(access);
      const controller = new AbortController();
      const snapshot = (revision: number) =>
        host.send({
          jsonrpc: "2.0",
          method: "desktop/credentialSnapshot",
          params: {
            revision,
            entries: [
              {
                cwd: "/repo",
                full: [mcp],
                project: [],
                envFull: {},
                envProject: {},
                readableFull: true,
                readableProject: true,
              },
            ],
          },
        });
      snapshot(1);
      host.onMessage((message) => {
        if (
          !("method" in message) ||
          !("id" in message) ||
          message.method !== "desktop/mcpLinkAction"
        )
          return;
        if (cancelTask) controller.abort();
        mcp.meta!.linkOAuthState = "reconnect";
        snapshot(2);
        host.send({
          jsonrpc: "2.0",
          id: message.id,
          error: {
            code: -32603,
            message: "reviewed reconnect",
            data: { mcpLinkCode: "reconnect" },
          },
        });
      });
      const result = JSON.parse(
        await linkActionTool(
          { provider: "figma", action: "get_metadata", params: { file_key: "FileOne" } },
          { ...ctx, signal: controller.signal },
        ),
      );
      expect(result.kind).toBe(cancelTask ? "error" : "authorization_required");
      if (!cancelTask) expect(result.connectionId).toBe(mcp.id);
    }
  });
});
