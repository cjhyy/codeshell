import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPluginHooks, listPluginHooks } from "./loadPluginHooks.js";
import { HookRegistry } from "../hooks/registry.js";

/**
 * loadPluginHooks reads the real ~/.code-shell/plugins/installed_plugins.json
 * via process.env.HOME, so we redirect HOME at a temp dir and stage a plugin
 * with a SessionStart hook on disk. This locks the disabledPlugins skip — the
 * contract that disabling "superpowers" suppresses its hook injection, not
 * just its Skill-tool entries.
 */

const origHome = process.env.HOME;
const dirs: string[] = [];

afterEach(() => {
  if (origHome === undefined) delete process.env.HOME;
  else process.env.HOME = origHome;
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs.length = 0;
});

function stagePlugin(pluginKey: string): void {
  const home = mkdtempSync(join(tmpdir(), "plughome-"));
  dirs.push(home);
  process.env.HOME = home;

  const installPath = join(home, "plugin-install");
  mkdirSync(join(installPath, "hooks"), { recursive: true });
  writeFileSync(
    join(installPath, "hooks", "hooks.json"),
    JSON.stringify({
      hooks: {
        SessionStart: [
          { hooks: [{ type: "command", command: "echo hi" }] },
        ],
      },
    }),
  );

  const pluginsDir = join(home, ".code-shell", "plugins");
  mkdirSync(pluginsDir, { recursive: true });
  writeFileSync(
    join(pluginsDir, "installed_plugins.json"),
    JSON.stringify({
      version: 2,
      plugins: {
        [pluginKey]: [
          {
            scope: "user",
            installPath,
            version: "1.0.0",
            installedAt: "2026-01-01",
            lastUpdated: "2026-01-01",
          },
        ],
      },
    }),
  );
}

describe("loadPluginHooks disabledPlugins filter", () => {
  test("registers a plugin's hooks when not disabled", () => {
    stagePlugin("superpowers@market");
    const reg = new HookRegistry();
    loadPluginHooks(reg);
    expect(reg.hasHooks("on_session_start")).toBe(true);
  });

  test("skips a plugin's hooks when its bare name is disabled", () => {
    stagePlugin("superpowers@market");
    const reg = new HookRegistry();
    loadPluginHooks(reg, ["superpowers"]);
    expect(reg.hasHooks("on_session_start")).toBe(false);
  });

  test("disabledPlugins matches the bare name, ignoring @marketplace", () => {
    stagePlugin("superpowers@some-other-marketplace");
    const reg = new HookRegistry();
    loadPluginHooks(reg, ["superpowers"]);
    expect(reg.hasHooks("on_session_start")).toBe(false);
  });

  test("an unrelated disabled name leaves the plugin's hooks intact", () => {
    stagePlugin("superpowers@market");
    const reg = new HookRegistry();
    loadPluginHooks(reg, ["something-else"]);
    expect(reg.hasHooks("on_session_start")).toBe(true);
  });
});

describe("listPluginHooks (read-only, for the settings UI)", () => {
  test("returns plugin hooks with owner name + mapped event + command", () => {
    stagePlugin("superpowers@market");
    const list = listPluginHooks();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      plugin: "superpowers",
      event: "on_session_start",
      rawEvent: "SessionStart",
      command: "echo hi",
      disabled: false,
    });
  });

  test("flags entries from a disabled plugin (still listed, disabled:true)", () => {
    stagePlugin("superpowers@market");
    const list = listPluginHooks(["superpowers"]);
    expect(list).toHaveLength(1); // still listed (read-only view)
    expect(list[0]!.disabled).toBe(true);
  });

  test("does not register anything (pure read)", () => {
    stagePlugin("superpowers@market");
    listPluginHooks();
    const reg = new HookRegistry();
    // A fresh registry that never had loadPluginHooks called stays empty.
    expect(reg.hasHooks("on_session_start")).toBe(false);
  });
});
