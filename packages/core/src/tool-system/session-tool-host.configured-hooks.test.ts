/**
 * Configured tool hooks must bind an external Agent Runtime exactly as they bind
 * the Native Engine.
 *
 * `SessionToolHost` used to build an empty `HookRegistry` when its caller passed
 * none, and no production caller did. Every external-runtime tool call still went
 * through `ToolExecutor` — which emits `pre_tool_use` / `post_tool_use` — but into
 * a registry with nothing in it, so a user's settings hooks and approved plugin
 * hooks silently never ran for Codex / Claude Code.
 *
 * Trust is part of the contract: `hooks` is a DANGEROUS_PROJECT_FIELD, so an
 * untrusted project's own `.code-shell/settings.json` must not register hooks
 * (they would run arbitrary commands), while the user's own layers still apply.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSessionToolHost, type CreateSessionToolHostOptions } from "./session-tool-host.js";
import { ToolRegistry } from "./registry.js";
import { HookRegistry } from "../hooks/registry.js";
import { pluginHooksDigest } from "../plugins/pluginHookIntegrity.js";
import type { BuiltinTool } from "./builtin/index.js";

const originalHome = process.env.HOME;
const dirs: string[] = [];
afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

/** A fresh HOME so user-layer settings and installed plugins are fixture-owned. */
function isolatedHome(): string {
  const home = tempDir("cs-hooks-home-");
  process.env.HOME = home;
  return home;
}

function writeSettings(root: string, settings: Record<string, unknown>): void {
  mkdirSync(join(root, ".code-shell"), { recursive: true });
  writeFileSync(join(root, ".code-shell", "settings.json"), JSON.stringify(settings));
}

const DENY = { event: "pre_tool_use", command: "echo 'blocked by policy' >&2; exit 2" };

function catalog(record: string[]): BuiltinTool[] {
  return [
    {
      definition: {
        name: "Watched",
        description: "A tool a hook may block.",
        inputSchema: { type: "object", properties: {} },
        source: "builtin",
        permissionDefault: "allow",
        isReadOnly: true,
        isConcurrencySafe: true,
      },
      execute: async () => {
        record.push("Watched");
        return "ran";
      },
      exposure: {
        presetTags: ["general"],
        defaultPermissionRules: [{ tool: "Watched", decision: "allow" }],
      },
    },
  ] as unknown as BuiltinTool[];
}

function host(
  cwd: string,
  record: string[],
  overrides: Partial<CreateSessionToolHostOptions> = {},
): ReturnType<typeof createSessionToolHost> {
  return createSessionToolHost({
    businessSessionId: "sess-hooks",
    cwd,
    registry: new ToolRegistry({ toolCatalog: catalog(record) }),
    permissionMode: "default",
    presetRules: [{ tool: "Watched", decision: "allow" }],
    projectTrusted: true,
    planMode: false,
    exposure: { mode: "allowlist", toolNames: new Set(["Watched"]) },
    visibility: { cwd, hasGoal: false, host: "desktop", isSubAgent: false },
    ...overrides,
  });
}

async function call(h: ReturnType<typeof createSessionToolHost>) {
  try {
    return await h.execute({ id: "c1", name: "Watched", input: {} });
  } finally {
    await h.dispose();
  }
}

describe("configured hooks reach external-runtime tool calls", () => {
  test("a trusted project's pre_tool_use hook blocks the call", async () => {
    isolatedHome();
    const cwd = tempDir("cs-hooks-project-");
    writeSettings(cwd, { hooks: [DENY] });
    const record: string[] = [];

    const result = await call(host(cwd, record));

    expect(result.isError).toBe(true);
    expect(result.error).toContain("Blocked by pre_tool_use hook");
    expect(result.error).toContain("blocked by policy");
    expect(record).toEqual([]);
  });

  test("a trusted project's post_tool_use hook runs after the tool", async () => {
    isolatedHome();
    const cwd = tempDir("cs-hooks-project-");
    const marker = join(cwd, "post-ran");
    writeSettings(cwd, {
      hooks: [{ event: "post_tool_use", command: `touch ${JSON.stringify(marker)}` }],
    });
    const record: string[] = [];

    const result = await call(host(cwd, record));

    expect(result.isError).toBeFalsy();
    expect(record).toEqual(["Watched"]);
    expect(existsSync(marker)).toBe(true);
  });

  test("an untrusted project cannot register hooks", async () => {
    // hooks is a DANGEROUS_PROJECT_FIELD: a cloned repo must not get to run
    // commands on every tool call before the user trusts it.
    isolatedHome();
    const cwd = tempDir("cs-hooks-untrusted-");
    const marker = join(cwd, "untrusted-hook-ran");
    writeSettings(cwd, {
      hooks: [DENY, { event: "post_tool_use", command: `touch ${JSON.stringify(marker)}` }],
    });
    const record: string[] = [];

    const result = await call(host(cwd, record, { projectTrusted: false }));

    expect(result.isError).toBeFalsy();
    expect(record).toEqual(["Watched"]);
    expect(existsSync(marker)).toBe(false);
  });

  test("the user's own hooks still bind an untrusted project under full scope", async () => {
    const home = isolatedHome();
    writeSettings(home, { hooks: [DENY] });
    const cwd = tempDir("cs-hooks-untrusted-");
    const record: string[] = [];

    const result = await call(host(cwd, record, { projectTrusted: false, settingsScope: "full" }));

    expect(result.isError).toBe(true);
    expect(record).toEqual([]);
  });

  test("project scope does not read the user's hooks, like the Native Engine", async () => {
    const home = isolatedHome();
    writeSettings(home, { hooks: [DENY] });
    const cwd = tempDir("cs-hooks-project-scope-");
    const record: string[] = [];

    const result = await call(host(cwd, record, { settingsScope: "project" }));

    expect(result.isError).toBeFalsy();
    expect(record).toEqual(["Watched"]);
  });

  test("a disabled settings hook does not register", async () => {
    isolatedHome();
    const cwd = tempDir("cs-hooks-disabled-");
    writeSettings(cwd, { hooks: [{ ...DENY, disabled: true }] });
    const record: string[] = [];

    const result = await call(host(cwd, record));

    expect(result.isError).toBeFalsy();
    expect(record).toEqual(["Watched"]);
  });

  describe("plugin hooks", () => {
    function stagePlugin(home: string, name: string, approved: boolean): void {
      const installPath = join(home, `plugin-${name}`);
      mkdirSync(join(installPath, "hooks"), { recursive: true });
      writeFileSync(
        join(installPath, "hooks", "hooks.json"),
        JSON.stringify({
          hooks: {
            PreToolUse: [
              {
                matcher: "Watched",
                hooks: [{ type: "command", command: "echo 'plugin says no' >&2; exit 2" }],
              },
            ],
          },
        }),
      );
      const digest = pluginHooksDigest(installPath);
      const pluginsDir = join(home, ".code-shell", "plugins");
      mkdirSync(pluginsDir, { recursive: true });
      writeFileSync(
        join(pluginsDir, "installed_plugins.json"),
        JSON.stringify({
          version: 2,
          plugins: {
            [`${name}@market`]: [
              {
                scope: "user",
                installPath,
                version: "1.0.0",
                installedAt: "2026-01-01",
                lastUpdated: "2026-01-01",
                hookDigest: digest,
                ...(approved ? { approvedHookDigest: digest } : {}),
              },
            ],
          },
        }),
      );
    }

    test("an approved plugin's PreToolUse hook blocks the call", async () => {
      const home = isolatedHome();
      stagePlugin(home, "guard", true);
      const cwd = tempDir("cs-hooks-plugin-");
      const record: string[] = [];

      const result = await call(host(cwd, record));

      expect(result.isError).toBe(true);
      expect(result.error).toContain("plugin says no");
      expect(record).toEqual([]);
    });

    test("an unapproved plugin hook fails closed and does not run", async () => {
      const home = isolatedHome();
      stagePlugin(home, "guard", false);
      const cwd = tempDir("cs-hooks-plugin-");
      const record: string[] = [];

      const result = await call(host(cwd, record));

      expect(result.isError).toBeFalsy();
      expect(record).toEqual(["Watched"]);
    });

    test("a plugin disabled in settings contributes no hooks", async () => {
      const home = isolatedHome();
      stagePlugin(home, "guard", true);
      const cwd = tempDir("cs-hooks-plugin-");
      writeSettings(cwd, { disabledPlugins: ["guard"] });
      const record: string[] = [];

      const result = await call(host(cwd, record));

      expect(result.isError).toBeFalsy();
      expect(record).toEqual(["Watched"]);
    });
  });

  test("an explicit hook registry is used as given", async () => {
    isolatedHome();
    const cwd = tempDir("cs-hooks-explicit-");
    writeSettings(cwd, { hooks: [DENY] });
    const record: string[] = [];
    const seen: string[] = [];
    const hooks = new HookRegistry();
    hooks.register("pre_tool_use", (ctx) => {
      seen.push(String(ctx.data.toolName));
      return {};
    });

    const result = await call(host(cwd, record, { hooks }));

    expect(result.isError).toBeFalsy();
    expect(seen).toEqual(["Watched"]);
    expect(record).toEqual(["Watched"]);
  });
});
