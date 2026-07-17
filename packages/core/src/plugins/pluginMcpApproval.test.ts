import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendInstallEntry, readInstalledPlugins } from "./installedPlugins.js";
import { approvePluginMcp, listPluginMcpTrust, revokePluginMcp } from "./pluginMcpApproval.js";
import { pluginMcpDigest } from "./pluginMcpIntegrity.js";
import { mergePluginMcpServers } from "./installer/loadPluginMcp.js";

describe("plugin MCP approval", () => {
  let home: string;
  let previousHome: string | undefined;
  let installPath: string;

  beforeEach(() => {
    previousHome = process.env.HOME;
    home = mkdtempSync(join(tmpdir(), "plugin-mcp-approval-"));
    process.env.HOME = home;
    installPath = join(home, "installed", "demo");
    mkdirSync(installPath, { recursive: true });
    writeFileSync(
      join(installPath, "mcp-servers.json"),
      JSON.stringify({ "demo:server": { command: "demo-mcp", name: "demo:server" } }),
    );
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  });

  function writeEntry(installKey = "demo@local", entry: Record<string, unknown> = {}): void {
    appendInstallEntry(installKey, {
      scope: "user",
      installPath,
      version: "1.0.0",
      installedAt: "t1",
      lastUpdated: "t1",
      ...entry,
    });
  }

  test("new recorded MCP stays disconnected until explicitly approved", () => {
    const mcpDigest = pluginMcpDigest(installPath);
    writeEntry("demo@local", { mcpDigest });

    expect(listPluginMcpTrust()).toEqual([
      {
        installKey: "demo@local",
        plugin: "demo",
        serverNames: ["server"],
        status: "pending",
      },
    ]);
    expect(mergePluginMcpServers({})["demo:server"]).toBeUndefined();

    expect(approvePluginMcp("demo")[0]).toMatchObject({
      installKey: "demo@local",
      status: "approved",
      changed: true,
    });
    expect(mergePluginMcpServers({})["demo:server"]).toBeDefined();

    expect(revokePluginMcp("demo@local")[0]).toMatchObject({
      status: "pending",
      changed: true,
    });
    expect(mergePluginMcpServers({})["demo:server"]).toBeUndefined();
  });

  test("legacy installs remain compatible until revoke freezes them into pending", () => {
    writeEntry();
    expect(listPluginMcpTrust()[0]?.status).toBe("legacy");
    expect(mergePluginMcpServers({})["demo:server"]).toBeDefined();

    expect(revokePluginMcp("demo")[0]?.status).toBe("pending");
    const entry = readInstalledPlugins().plugins["demo@local"]?.[0];
    expect(entry?.mcpDigest).toBe(pluginMcpDigest(installPath));
    expect(entry?.approvedMcpDigest).toBeUndefined();
    expect(mergePluginMcpServers({})["demo:server"]).toBeUndefined();
  });

  test("post-install MCP changes cannot be directly approved", () => {
    writeEntry("demo@local", { mcpDigest: pluginMcpDigest(installPath) });
    writeFileSync(
      join(installPath, "mcp-servers.json"),
      JSON.stringify({ "demo:server": { command: "tampered", name: "demo:server" } }),
    );

    expect(listPluginMcpTrust()[0]?.status).toBe("changed");
    expect(mergePluginMcpServers({})["demo:server"]).toBeUndefined();
    expect(() => approvePluginMcp("demo")).toThrow(/changed after install/);
  });

  test("bare plugin names require an install key when multiple installs exist", () => {
    writeEntry("demo@one");
    writeEntry("demo@two");
    expect(() => approvePluginMcp("demo")).toThrow(/multiple installs/);
    expect(approvePluginMcp("demo@one")).toHaveLength(1);
  });

  test("plugins without valid MCP servers stay silent and do not gate user servers", () => {
    writeFileSync(join(installPath, "mcp-servers.json"), JSON.stringify({ invalid: {} }));
    writeEntry("demo@local", { mcpDigest: pluginMcpDigest(installPath) });
    expect(listPluginMcpTrust()[0]).toMatchObject({ serverNames: [], status: "none" });
    expect(
      mergePluginMcpServers({
        user: { command: "user-mcp", name: "user" } as never,
      }),
    ).toHaveProperty("user");
  });
});
