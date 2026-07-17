import { describe, expect, it } from "bun:test";
import {
  isEditableMcpServer,
  isHttpMcpAuthConfigured,
  isToggleableMcpServer,
  inferHttpAuthMode,
  mcpEffectiveProjectPath,
  mcpServersFromSettings,
  persistableMcpServers,
  ownerPluginOf,
  visiblePluginMcpTrustEntries,
} from "./McpSection";

describe("plugin MCP servers in settings UI", () => {
  it("marks plugin-provided servers as readonly", () => {
    expect(isEditableMcpServer({ name: "local", command: "npx", source: "settings" })).toBe(true);
    expect(isEditableMcpServer({ name: "plug:server", command: "npx", source: "plugin" })).toBe(
      false,
    );
    expect(isEditableMcpServer({ name: "readonly", command: "npx", editable: false })).toBe(false);
  });

  it("allows per-server toggles without making plugin identity fields editable", () => {
    expect(isToggleableMcpServer({ name: "plug:server", source: "plugin" })).toBe(true);
    expect(
      isToggleableMcpServer({
        name: "plug:server",
        source: "plugin",
        pluginDisabled: true,
      }),
    ).toBe(false);
  });

  it("does not persist plugin-provided servers back into settings", () => {
    const servers = [
      { name: "local", command: "npx", source: "settings" as const },
      { name: "plug:server", command: "tool", source: "plugin" as const, editable: false },
    ];

    expect(persistableMcpServers(servers).map((s) => s.name)).toEqual(["local"]);
  });

  it("parses merged MCP records with source metadata", () => {
    const out = mcpServersFromSettings({
      local: { command: "npx", source: "settings", editable: true },
      "plug:server": {
        command: "tool",
        source: "plugin",
        editable: false,
        allowedTools: ["search"],
        disabledTools: ["delete"],
      },
    });

    expect(out).toEqual([
      { name: "local", command: "npx", source: "settings", editable: true },
      {
        name: "plug:server",
        command: "tool",
        source: "plugin",
        editable: false,
        allowedTools: ["search"],
        disabledTools: ["delete"],
      },
    ]);
  });

  it("derives the owning plugin name from a plugin server's key", () => {
    expect(ownerPluginOf({ name: "supabase:db", command: "x", source: "plugin" })).toBe("supabase");
    // user servers have no owner
    expect(ownerPluginOf({ name: "local", command: "x", source: "settings" })).toBeUndefined();
    // plugin server with no prefix → undefined (defensive)
    expect(ownerPluginOf({ name: "weird", command: "x", source: "plugin" })).toBeUndefined();
  });

  it("treats Bearer and custom header auth as configured HTTP auth", () => {
    expect(isHttpMcpAuthConfigured({})).toBe(false);
    expect(isHttpMcpAuthConfigured({ credentialRef: "stored-token" })).toBe(true);
    expect(isHttpMcpAuthConfigured({ bearerTokenEnvVar: "MCP_TOKEN" })).toBe(true);
    expect(isHttpMcpAuthConfigured({ envHeaders: { "x-api-key": "MCP_API_KEY" } })).toBe(true);
    expect(isHttpMcpAuthConfigured({ headers: { "X-Client-Name": "code-shell" } })).toBe(true);
  });

  it("infers the primary HTTP auth mode without changing old auth config", () => {
    expect(inferHttpAuthMode({})).toBe("none");
    expect(inferHttpAuthMode({ bearerTokenEnvVar: "MCP_TOKEN" })).toBe("bearer");
    expect(inferHttpAuthMode({ envHeaders: { "x-api-key": "MCP_API_KEY" } })).toBe("headers");
    expect(
      inferHttpAuthMode({ credentialRef: "figma-oauth" }, [{ id: "figma-oauth", type: "oauth" }]),
    ).toBe("oauth");
    expect(
      inferHttpAuthMode({ credentialRef: "plain-token" }, [{ id: "plain-token", type: "token" }]),
    ).toBe("bearer");
  });

  it("folds plugin capability state for the project being edited", () => {
    expect(mcpEffectiveProjectPath("project", "/selected", "/active")).toBe("/selected");
    expect(mcpEffectiveProjectPath("user", null, "/active")).toBe("/active");
  });

  it("shows actionable plugin MCP trust states while hiding MCP-free installs", () => {
    expect(
      visiblePluginMcpTrustEntries([
        {
          installKey: "pending@local",
          plugin: "pending",
          serverNames: ["server"],
          status: "pending",
        },
        {
          installKey: "empty@local",
          plugin: "empty",
          serverNames: [],
          status: "none",
        },
      ]),
    ).toEqual([
      {
        installKey: "pending@local",
        plugin: "pending",
        serverNames: ["server"],
        status: "pending",
      },
    ]);
  });
});
