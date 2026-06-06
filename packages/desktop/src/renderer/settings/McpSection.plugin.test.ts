import { describe, expect, it } from "bun:test";
import {
  isEditableMcpServer,
  mcpServersFromSettings,
  persistableMcpServers,
  ownerPluginOf,
} from "./McpSection";

describe("plugin MCP servers in settings UI", () => {
  it("marks plugin-provided servers as readonly", () => {
    expect(isEditableMcpServer({ name: "local", command: "npx", source: "settings" })).toBe(true);
    expect(isEditableMcpServer({ name: "plug:server", command: "npx", source: "plugin" })).toBe(false);
    expect(isEditableMcpServer({ name: "readonly", command: "npx", editable: false })).toBe(false);
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
      "plug:server": { command: "tool", source: "plugin", editable: false },
    });

    expect(out).toEqual([
      { name: "local", command: "npx", source: "settings", editable: true },
      { name: "plug:server", command: "tool", source: "plugin", editable: false },
    ]);
  });

  it("derives the owning plugin name from a plugin server's key", () => {
    expect(ownerPluginOf({ name: "supabase:db", command: "x", source: "plugin" })).toBe("supabase");
    // user servers have no owner
    expect(ownerPluginOf({ name: "local", command: "x", source: "settings" })).toBeUndefined();
    // plugin server with no prefix → undefined (defensive)
    expect(ownerPluginOf({ name: "weird", command: "x", source: "plugin" })).toBeUndefined();
  });
});
