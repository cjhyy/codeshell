import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mergePluginMcpServers } from "./loadPluginMcp.js";
import { appendInstallEntry, pluginInstallKey } from "../installedPlugins.js";

describe("mergePluginMcpServers", () => {
  let home: string, prev: string | undefined;
  beforeEach(() => {
    prev = process.env.HOME;
    home = mkdtempSync(join(tmpdir(), "cs-pm-"));
    process.env.HOME = home;
  });
  afterEach(() => {
    process.env.HOME = prev;
    rmSync(home, { recursive: true, force: true });
  });

  function regPlugin(name: string, servers: Record<string, unknown>) {
    const p = join(home, ".code-shell", "plugins", name);
    mkdirSync(p, { recursive: true });
    writeFileSync(join(p, "mcp-servers.json"), JSON.stringify(servers));
    appendInstallEntry(pluginInstallKey(name, "local"), {
      scope: "user", installPath: p, version: "1", installedAt: "t", lastUpdated: "t",
    });
  }

  test("merges plugin servers into the base map", () => {
    regPlugin("p1", { "p1:fs": { command: "f", name: "p1:fs" } });
    const merged = mergePluginMcpServers({ user1: { command: "u", name: "user1" } as any }, []);
    expect(merged.user1).toBeDefined();
    expect(merged["p1:fs"]).toMatchObject({ command: "f" });
  });

  test("skips disabled plugins", () => {
    regPlugin("p2", { "p2:x": { command: "x", name: "p2:x" } });
    const merged = mergePluginMcpServers({}, ["p2"]);
    expect(merged["p2:x"]).toBeUndefined();
  });

  test("user-configured key wins over plugin same-key", () => {
    regPlugin("p3", { dup: { command: "plugin", name: "dup" } });
    const merged = mergePluginMcpServers({ dup: { command: "user", name: "dup" } as any }, []);
    expect(merged.dup.command).toBe("user");
  });
});
