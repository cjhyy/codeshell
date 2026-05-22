import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadPluginHooks } from "../packages/core/src/plugins/loadPluginHooks.js";
import { HookRegistry } from "../packages/core/src/hooks/registry.js";

let workDir: string;
let savedHome: string | undefined;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "loadhooks-"));
  savedHome = process.env.HOME;
  process.env.HOME = workDir;
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
});

function installPlugin(
  pluginName: string,
  marketplace: string,
  hooksJson: object | null,
): string {
  const installPath = join(workDir, "plugins", marketplace, pluginName);
  mkdirSync(join(installPath, "hooks"), { recursive: true });
  if (hooksJson !== null) {
    writeFileSync(join(installPath, "hooks", "hooks.json"), JSON.stringify(hooksJson));
  }
  const manifestPath = join(workDir, ".code-shell", "plugins", "installed_plugins.json");
  mkdirSync(join(workDir, ".code-shell", "plugins"), { recursive: true });

  type Entry = { scope: "user"; installPath: string; version: string; installedAt: string; lastUpdated: string };
  let manifest: { version: 2; plugins: Record<string, Entry[]> } = { version: 2, plugins: {} };
  try {
    manifest = JSON.parse(require("node:fs").readFileSync(manifestPath, "utf8"));
  } catch {
    /* first call — keep default */
  }
  manifest.plugins[`${pluginName}@${marketplace}`] = [
    {
      scope: "user",
      installPath,
      version: "1.0",
      installedAt: "2026-05-20T00:00:00Z",
      lastUpdated: "2026-05-20T00:00:00Z",
    },
  ];
  writeFileSync(manifestPath, JSON.stringify(manifest));
  return installPath;
}

describe("loadPluginHooks", () => {
  it("registers SessionStart command hooks under on_session_start", () => {
    installPlugin("foo", "mp", {
      hooks: {
        SessionStart: [
          {
            matcher: "startup|clear|compact",
            hooks: [{ type: "command", command: "echo hi" }],
          },
        ],
      },
    });
    const reg = new HookRegistry();
    loadPluginHooks(reg);
    const names = reg.listHooks().get("on_session_start") ?? [];
    expect(names.some((n) => n.includes("plugin:foo:SessionStart"))).toBe(true);
  });

  it("maps UserPromptSubmit → user_prompt_submit", () => {
    installPlugin("foo", "mp", {
      hooks: {
        UserPromptSubmit: [{ hooks: [{ type: "command", command: "echo hi" }] }],
      },
    });
    const reg = new HookRegistry();
    loadPluginHooks(reg);
    expect(reg.countHandlers("user_prompt_submit")).toBe(1);
  });

  it("maps PreToolUse / PostToolUse to snake_case", () => {
    installPlugin("foo", "mp", {
      hooks: {
        PreToolUse: [{ hooks: [{ type: "command", command: "true" }] }],
        PostToolUse: [{ hooks: [{ type: "command", command: "true" }] }],
      },
    });
    const reg = new HookRegistry();
    loadPluginHooks(reg);
    expect(reg.countHandlers("pre_tool_use")).toBe(1);
    expect(reg.countHandlers("post_tool_use")).toBe(1);
  });

  it("skips unknown event names (e.g. SubagentStop)", () => {
    installPlugin("foo", "mp", {
      hooks: {
        SubagentStop: [{ hooks: [{ type: "command", command: "echo hi" }] }],
        Unknown: [{ hooks: [{ type: "command", command: "echo hi" }] }],
      },
    });
    const reg = new HookRegistry();
    loadPluginHooks(reg);
    expect(reg.listEvents().length).toBe(0);
  });

  it("ignores non-command hook types", () => {
    installPlugin("foo", "mp", {
      hooks: {
        SessionStart: [{ hooks: [{ type: "wasm", command: "x" }] }],
      },
    });
    const reg = new HookRegistry();
    loadPluginHooks(reg);
    expect(reg.countHandlers("on_session_start")).toBe(0);
  });

  it("loads hooks from multiple plugins", () => {
    installPlugin("alpha", "mp", {
      hooks: { SessionStart: [{ hooks: [{ type: "command", command: "echo a" }] }] },
    });
    installPlugin("beta", "mp", {
      hooks: { SessionStart: [{ hooks: [{ type: "command", command: "echo b" }] }] },
    });
    const reg = new HookRegistry();
    loadPluginHooks(reg);
    expect(reg.countHandlers("on_session_start")).toBe(2);
  });

  it("silently skips plugins with malformed hooks.json", () => {
    const installPath = join(workDir, "plugins", "mp", "broken");
    mkdirSync(join(installPath, "hooks"), { recursive: true });
    writeFileSync(join(installPath, "hooks", "hooks.json"), "{ not valid json");
    const manifestPath = join(workDir, ".code-shell", "plugins", "installed_plugins.json");
    mkdirSync(join(workDir, ".code-shell", "plugins"), { recursive: true });
    writeFileSync(
      manifestPath,
      JSON.stringify({
        version: 2,
        plugins: {
          "broken@mp": [
            {
              scope: "user",
              installPath,
              version: "1",
              installedAt: "x",
              lastUpdated: "x",
            },
          ],
        },
      }),
    );
    const reg = new HookRegistry();
    // Must not throw.
    loadPluginHooks(reg);
    expect(reg.listEvents().length).toBe(0);
  });

  it("plugin without hooks/hooks.json contributes nothing", () => {
    installPlugin("noop", "mp", null);
    const reg = new HookRegistry();
    loadPluginHooks(reg);
    expect(reg.listEvents().length).toBe(0);
  });
});

describe("loadPluginHooks — matcher semantics on emit", () => {
  it("SessionStart matcher filters on ctx.data.source", async () => {
    installPlugin("foo", "mp", {
      hooks: {
        SessionStart: [
          {
            matcher: "^startup$",
            hooks: [
              {
                type: "command",
                command: `printf '{"additionalContext":"fired"}'`,
              },
            ],
          },
        ],
      },
    });
    const reg = new HookRegistry();
    loadPluginHooks(reg);

    const startup = await reg.emit("on_session_start", { source: "startup" });
    expect(startup.messages).toEqual(["fired"]);

    const resume = await reg.emit("on_session_start", { source: "resume" });
    expect(resume.messages ?? []).toEqual([]);
  });

  it("PreToolUse matcher filters on ctx.data.toolName", async () => {
    installPlugin("foo", "mp", {
      hooks: {
        PreToolUse: [
          {
            matcher: "^Bash$",
            hooks: [
              {
                type: "command",
                command: `printf '{"additionalContext":"bash-only"}'`,
              },
            ],
          },
        ],
      },
    });
    const reg = new HookRegistry();
    loadPluginHooks(reg);

    const matched = await reg.emit("pre_tool_use", { toolName: "Bash" });
    expect(matched.messages).toEqual(["bash-only"]);

    const skipped = await reg.emit("pre_tool_use", { toolName: "Edit" });
    expect(skipped.messages ?? []).toEqual([]);
  });
});
