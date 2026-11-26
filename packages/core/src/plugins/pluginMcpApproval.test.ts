import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendInstallEntry, readInstalledPlugins } from "./installedPlugins.js";
import { approvePluginHooks, reviewPluginHooks } from "./pluginHookApproval.js";
import { approvePluginMcp, listPluginMcpTrust, revokePluginMcp } from "./pluginMcpApproval.js";
import { pluginMcpDigest } from "./pluginMcpIntegrity.js";
import { computePluginTreeDigest } from "./pluginTreeDigest.js";
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

  function treeDigest(): string {
    const tree = computePluginTreeDigest(installPath);
    if (!tree.ok) throw new Error(tree.reason);
    return tree.digest;
  }

  test("checks the initiating document before persisting either trust transition", () => {
    writeEntry("demo@local", { mcpDigest: pluginMcpDigest(installPath) });
    const registry = () => JSON.stringify(readInstalledPlugins());
    const reject = () => {
      throw Error("Document revoked");
    };
    const before = registry();
    expect(() => approvePluginMcp("demo@local", reject)).toThrow("Document revoked");
    expect(registry()).toBe(before);
    approvePluginMcp("demo@local");
    const accepted = registry();
    expect(() => revokePluginMcp("demo@local", reject)).toThrow("Document revoked");
    expect(registry()).toBe(accepted);
  });

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

  test("an install recorded before MCP digests stays disconnected until approved once", () => {
    writeEntry();
    expect(listPluginMcpTrust()[0]?.status).toBe("pending");
    expect(mergePluginMcpServers({})["demo:server"]).toBeUndefined();

    expect(approvePluginMcp("demo")[0]).toMatchObject({ status: "approved", changed: true });
    expect(readInstalledPlugins().plugins["demo@local"]?.[0]).toMatchObject({
      mcpDigest: pluginMcpDigest(installPath),
      approvedMcpDigest: pluginMcpDigest(installPath),
      contentDigest: treeDigest(),
      approvedContentDigest: treeDigest(),
    });
    expect(mergePluginMcpServers({})["demo:server"]).toBeDefined();

    expect(revokePluginMcp("demo")[0]?.status).toBe("pending");
    expect(mergePluginMcpServers({})["demo:server"]).toBeUndefined();
  });

  test("an MCP approval granted before whole-tree approval does not carry over", () => {
    const mcpDigest = pluginMcpDigest(installPath);
    writeEntry("demo@local", { mcpDigest, approvedMcpDigest: mcpDigest });
    expect(listPluginMcpTrust()[0]?.status).toBe("pending");
    expect(mergePluginMcpServers({})["demo:server"]).toBeUndefined();
  });

  test("a server script changed after approval disconnects the server", () => {
    writeFileSync(join(installPath, "server.js"), "console.log('approved');\n");
    writeEntry();
    approvePluginMcp("demo");
    expect(mergePluginMcpServers({})["demo:server"]).toBeDefined();

    writeFileSync(join(installPath, "server.js"), "console.log('tampered');\n");
    expect(listPluginMcpTrust()[0]?.status).toBe("changed");
    expect(mergePluginMcpServers({})["demo:server"]).toBeUndefined();
    expect(() => approvePluginMcp("demo")).toThrow(/changed after install/);

    writeFileSync(join(installPath, "server.js"), "console.log('approved');\n");
    expect(listPluginMcpTrust()[0]?.status).toBe("approved");
  });

  test("hooks and MCP share the content approval but are still approved separately", () => {
    mkdirSync(join(installPath, "hooks"));
    writeFileSync(
      join(installPath, "hooks", "hooks.json"),
      JSON.stringify({
        hooks: { SessionStart: [{ hooks: [{ type: "command", command: "echo demo" }] }] },
      }),
    );
    writeEntry();

    approvePluginMcp("demo");
    expect(listPluginMcpTrust()[0]?.status).toBe("approved");
    expect(reviewPluginHooks("demo")[0]?.status).toBe("pending");

    approvePluginHooks("demo");
    expect(reviewPluginHooks("demo")[0]?.status).toBe("approved");

    revokePluginMcp("demo");
    expect(listPluginMcpTrust()[0]?.status).toBe("pending");
    expect(reviewPluginHooks("demo")[0]?.status).toBe("approved");
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
