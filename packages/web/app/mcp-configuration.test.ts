import { afterEach, describe, expect, test } from "bun:test";
import { ApiError } from "./auth.js";
import {
  cancelMcpProbe,
  makeMcpDraft,
  mcpDraftPayload,
  needsMcpSecretReuse,
  readMcpConfiguration,
  saveMcpServer,
  type HubMcpServer,
} from "./mcp-configuration.js";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});
const server: HubMcpServer = {
  name: "plugin:service",
  source: "settings",
  scope: "project",
  editable: true,
  deletable: true,
  hasLocalOverride: false,
  pluginDisabled: false,
  enabled: false,
  transport: "streamable-http",
  argsCount: 2,
  url: "https://example.test/mcp",
  urlHasHiddenParts: true,
  envKeys: ["API_KEY"],
  headerKeys: ["Authorization"],
  envVars: ["FORWARDED_TOKEN"],
  envHeaders: { "X-Token": "TOKEN_ENV" },
  credentialRef: "stored-credential",
  disabledTools: [],
};

describe("Hub MCP browser configuration", () => {
  test("never places stored secrets or arguments into editable values", () => {
    const draft = makeMcpDraft(server);
    expect(draft.args).toBe("");
    expect(draft.env[0]?.value).toBe("");
    expect(draft.headers[0]?.value).toBe("");
    expect(draft.envHeaders[0]?.value).toBe("TOKEN_ENV");
    expect(mcpDraftPayload(draft, server)).toEqual({
      name: "plugin:service",
    });
  });
  test("only sends explicit secret replacements and null removals, preserving hidden URL parts and unrelated inherited config", () => {
    const draft = makeMcpDraft(server);
    draft.headers[0]!.removed = true;
    draft.env[0]!.value = "replacement-key";
    expect(mcpDraftPayload(draft, server)).toEqual({
      name: "plugin:service",
      headers: { Authorization: null },
      env: { API_KEY: "replacement-key" },
    });
    draft.headers[0]!.removed = false;
    expect(mcpDraftPayload(draft, server)).not.toHaveProperty("headers");
    expect(mcpDraftPayload(draft, server)).not.toHaveProperty("url");
  });
  test("does not overwrite another device's enabled state or transport when the editor did not change them", () => {
    const draft = makeMcpDraft(server);
    draft.headers[0]!.value = "replacement";
    const patch = mcpDraftPayload(draft, server);
    expect(patch).not.toHaveProperty("enabled");
    expect(patch).not.toHaveProperty("transport");
    draft.enabled = !server.enabled;
    draft.transport = "stdio";
    draft.command = "node";
    expect(mcpDraftPayload(draft, server)).toMatchObject({ enabled: true, transport: "stdio" });
  });
  test("rejects duplicate or prototype keys instead of silently discarding requested secrets", () => {
    const draft = makeMcpDraft(server);
    draft.headers.push({
      id: "new",
      name: "authorization",
      value: "secret",
      stored: false,
      removed: false,
    });
    expect(() => mcpDraftPayload(draft, server)).toThrow("不能重复");
    draft.headers = [
      { id: "new", name: "__proto__", value: "secret", stored: false, removed: false },
    ];
    expect(() => mcpDraftPayload(draft, server)).toThrow("名称无效");
  });
  test("keeps literal arguments as individual lines, and clearing them is an explicit operation", () => {
    const stdio = { ...server, transport: "stdio", command: "node", url: undefined };
    const draft = makeMcpDraft(stdio);
    expect(mcpDraftPayload(draft, stdio)).not.toHaveProperty("args");
    draft.args = "/path with spaces/server.mjs\n--label\ntwo words";
    expect(mcpDraftPayload(draft, stdio).args).toEqual([
      "/path with spaces/server.mjs",
      "--label",
      "two words",
    ]);
    expect(needsMcpSecretReuse(draft, stdio)).toBe(true);
    draft.clearArgs = true;
    expect(mcpDraftPayload(draft, stdio).args).toEqual([]);
  });
  test("requires deliberate credential reuse when switching origin while a path-only change retains its origin", () => {
    const draft = makeMcpDraft(server);
    draft.url = "https://example.test/another-mcp";
    expect(needsMcpSecretReuse(draft, server)).toBe(false);
    draft.url = "https://different.test/mcp";
    expect(needsMcpSecretReuse(draft, server)).toBe(true);
    expect(mcpDraftPayload(draft, server)).not.toHaveProperty("reuseStoredSecrets");
    draft.reuseStoredSecrets = true;
    expect(mcpDraftPayload(draft, server).reuseStoredSecrets).toBe(true);
  });
  test("409 preserves all drafts while requests use encoded names, same-origin cookies and no cache", async () => {
    const draft = makeMcpDraft(server);
    draft.headers[0]!.value = "entered-secret";
    let captured: RequestInit | undefined;
    globalThis.fetch = (async (path, init) => {
      expect(String(path)).toBe("/api/v1/mcp/servers/plugin%3Aservice");
      captured = init;
      return Response.json({ error: "请等待任务完成。" }, { status: 409 });
    }) as typeof fetch;
    await expect(saveMcpServer(draft, server)).rejects.toBeInstanceOf(ApiError);
    expect(draft.headers[0]!.value).toBe("entered-secret");
    expect(captured?.credentials).toBe("same-origin");
    expect(captured?.cache).toBe("no-store");
    expect(captured?.method).toBe("PUT");
  });
  test("explicit cancellation uses a keepalive authenticated request so route changes can stop the process", async () => {
    globalThis.fetch = (async (path, init) => {
      expect(String(path)).toBe("/api/v1/mcp/servers/plugin%3Aservice/cancel-probe");
      expect(init?.keepalive).toBe(true);
      expect(init?.body).toBe("{}");
      return Response.json({ cancelled: true });
    }) as typeof fetch;
    await expect(cancelMcpProbe("plugin:service")).resolves.toEqual({ cancelled: true });
  });
  test("invalid HTML fallbacks cannot masquerade as loaded MCP settings", async () => {
    globalThis.fetch = (async () => new Response("<!doctype html>offline")) as typeof fetch;
    await expect(readMcpConfiguration()).rejects.toThrow("无效的 MCP 配置");
  });
});
