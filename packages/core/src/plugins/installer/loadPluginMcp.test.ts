import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
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
      scope: "user",
      installPath: p,
      version: "1",
      installedAt: "t",
      lastUpdated: "t",
    });
  }

  /** A CC plugin that only ships a raw .mcp.json (mcpServers wrapper, no prefix). */
  function regCcPlugin(name: string, mcpJson: Record<string, unknown>) {
    const p = join(home, ".code-shell", "plugins", name);
    mkdirSync(p, { recursive: true });
    writeFileSync(join(p, ".mcp.json"), JSON.stringify(mcpJson));
    appendInstallEntry(pluginInstallKey(name, "local"), {
      scope: "user",
      installPath: p,
      version: "1",
      installedAt: "t",
      lastUpdated: "t",
    });
  }

  test("falls back to .mcp.json when no mcp-servers.json (CC plugin), keying <plugin>:<server>", () => {
    regCcPlugin("docker", {
      mcpServers: { "mcp-gateway": { command: "docker", args: ["mcp", "gateway", "run"] } },
    });
    const merged = mergePluginMcpServers({}, []);
    expect(merged["docker:mcp-gateway"]).toBeDefined();
    expect(merged["docker:mcp-gateway"]).toMatchObject({
      command: "docker",
      name: "docker:mcp-gateway",
    });
  });

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
    regPlugin("p3", { "p3:dup": { command: "plugin", name: "p3:dup" } });
    const merged = mergePluginMcpServers(
      { "p3:dup": { command: "user", name: "p3:dup" } as any },
      [],
    );
    expect(merged["p3:dup"].command).toBe("user");
  });

  test("keeps plugin servers inside their own namespace and overwrites spoofed name fields", () => {
    regPlugin("safe", {
      "safe:ok": { command: "ok", name: "other:spoofed" },
      "other:escape": { command: "escape", name: "other:escape" },
      bare: { command: "bare", name: "bare" },
    });
    const merged = mergePluginMcpServers({}, []);
    expect(merged["safe:ok"]).toEqual({ command: "ok", name: "safe:ok" });
    expect(merged["other:escape"]).toBeUndefined();
    expect(merged.bare).toBeUndefined();
  });

  test("drops malformed plugin servers before MCPManager startup", () => {
    regPlugin("bad", {
      "bad:no-command": { transport: "stdio" },
      "bad:no-url": { transport: "streamable-http" },
      "bad:inprocess": { transport: "inprocess", command: "x" },
      "bad:credentials": { url: "https://user:secret@example.com/mcp" },
      "bad:invalid-env": { command: "x", envVars: ["OK", "NOT=VALID"] },
      "bad:invalid-header": { url: "https://example.com/mcp", headers: { "Bad Header": "x" } },
      "bad:header-injection": {
        url: "https://example.com/mcp",
        headers: { Authorization: "safe\r\nInjected: true" },
      },
      "bad:valid": {
        command: "mcp-server",
        args: ["--stdio"],
        env: { MODE: "safe" },
        envVars: ["TOKEN"],
        enabled: false,
        allowed_tools: ["read", "search"],
        disabledTools: ["delete"],
        ignored: "field",
      },
    });
    const merged = mergePluginMcpServers({}, []);
    expect(Object.keys(merged)).toEqual(["bad:valid"]);
    expect(merged["bad:valid"]).toEqual({
      name: "bad:valid",
      command: "mcp-server",
      args: ["--stdio"],
      env: { MODE: "safe" },
      envVars: ["TOKEN"],
      enabled: false,
      allowedTools: ["read", "search"],
      disabledTools: ["delete"],
    });
  });

  test("rejects an excessive server map as a unit", () => {
    regPlugin(
      "many",
      Object.fromEntries(
        Array.from({ length: 65 }, (_, index) => [
          `many:s${index}`,
          { command: "mcp-server", name: `many:s${index}` },
        ]),
      ),
    );
    expect(mergePluginMcpServers({}, [])).toEqual({});
  });

  test("normalizes raw .mcp.json names and rejects invalid server identifiers", () => {
    regCcPlugin("cc", {
      mcpServers: {
        valid_name: { url: "http://127.0.0.1:3000/mcp" },
        "bad:name": { command: "x" },
        "../escape": { command: "x" },
      },
    });
    expect(mergePluginMcpServers({}, [])).toEqual({
      "cc:valid_name": {
        name: "cc:valid_name",
        url: "http://127.0.0.1:3000/mcp",
      },
    });
  });

  test("does not load MCP config symlinks or oversized files", () => {
    if (process.platform === "win32") return;
    const plugin = join(home, ".code-shell", "plugins", "unsafe");
    const outside = mkdtempSync(join(tmpdir(), "cs-pm-outside-"));
    mkdirSync(plugin, { recursive: true });
    writeFileSync(
      join(outside, ".mcp.json"),
      JSON.stringify({ mcpServers: { escape: { command: "outside" } } }),
    );
    symlinkSync(join(outside, ".mcp.json"), join(plugin, ".mcp.json"));
    appendInstallEntry(pluginInstallKey("unsafe", "local"), {
      scope: "user",
      installPath: plugin,
      version: "1",
      installedAt: "t",
      lastUpdated: "t",
    });
    try {
      expect(mergePluginMcpServers({}, [])["unsafe:escape"]).toBeUndefined();
      rmSync(join(plugin, ".mcp.json"));
      writeFileSync(
        join(plugin, "mcp-servers.json"),
        JSON.stringify({ "unsafe:large": { command: "large", name: "unsafe:large" } }),
      );
      truncateSync(join(plugin, "mcp-servers.json"), 1024 * 1024 + 1);
      expect(mergePluginMcpServers({}, [])["unsafe:large"]).toBeUndefined();
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  describe("overrides (plugin MCP policy and credential supplement)", () => {
    test("layers server/tool policy and env/credential fields onto the plugin config", () => {
      regPlugin("gh", { "gh:server": { command: "gh-mcp", name: "gh:server" } });
      const merged = mergePluginMcpServers({}, [], {
        "gh:server": {
          enabled: false,
          allowedTools: ["search"],
          disabledTools: ["delete"],
          envVars: ["GITHUB_TOKEN"],
          env: { FOO: "bar" },
        },
      });
      // command stays from the plugin; override fields are added on top.
      expect(merged["gh:server"].command).toBe("gh-mcp");
      expect(merged["gh:server"].enabled).toBe(false);
      expect(merged["gh:server"].allowedTools).toEqual(["search"]);
      expect(merged["gh:server"].disabledTools).toEqual(["delete"]);
      expect(merged["gh:server"].envVars).toEqual(["GITHUB_TOKEN"]);
      expect(merged["gh:server"].env).toEqual({ FOO: "bar" });
    });

    test("override NEVER replaces command/args/url/transport — those stay from the plugin", () => {
      regPlugin("gh", {
        "gh:server": { command: "gh-mcp", args: ["serve"], name: "gh:server" },
      });
      const merged = mergePluginMcpServers({}, [], {
        // Even if a malformed override smuggles command/url, the plugin wins.
        "gh:server": { command: "evil", url: "http://evil", credentialRef: "cred1" } as any,
      });
      expect(merged["gh:server"].command).toBe("gh-mcp");
      expect(merged["gh:server"].args).toEqual(["serve"]);
      expect(merged["gh:server"].url).toBeUndefined();
      expect(merged["gh:server"].credentialRef).toBe("cred1");
    });

    test("override for an unknown server key has no effect (does not conjure a server)", () => {
      regPlugin("gh", { "gh:server": { command: "gh-mcp", name: "gh:server" } });
      const merged = mergePluginMcpServers({}, [], {
        "ghost:nope": { credentialRef: "cred1" },
      });
      expect(merged["ghost:nope"]).toBeUndefined();
    });

    test("override does NOT apply to a user-added (base) server of the same key", () => {
      const merged = mergePluginMcpServers(
        { mine: { command: "u", name: "mine", credentialRef: "userCred" } as any },
        [],
        { mine: { credentialRef: "overrideCred" } },
      );
      // User-added servers are edited directly via mcpServers; the override
      // layer is only for plugin-sourced servers.
      expect(merged.mine.credentialRef).toBe("userCred");
    });

    test("disabled plugin is still skipped even if an override exists for it", () => {
      regPlugin("gh", { "gh:server": { command: "gh-mcp", name: "gh:server" } });
      const merged = mergePluginMcpServers({}, ["gh"], {
        "gh:server": { credentialRef: "cred1" },
      });
      expect(merged["gh:server"]).toBeUndefined();
    });
  });
});
