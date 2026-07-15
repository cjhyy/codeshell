import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SettingsManager } from "../settings/manager.js";
import { computeEffectiveDisabledLists } from "./disabled-lists.js";

/**
 * The user-reported bug (能力总览): a plugin globally disabled in
 * ~/.code-shell/settings.json but force-enabled at PROJECT level via
 * capabilityOverrides must come out of the effective disabledPlugins —
 * the MCP merge consumers all fold through this helper now.
 */
describe("computeEffectiveDisabledLists", () => {
  let home: string;
  let cwd: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    prevHome = process.env.HOME;
    home = mkdtempSync(join(tmpdir(), "cs-eff-home-"));
    cwd = mkdtempSync(join(tmpdir(), "cs-eff-cwd-"));
    process.env.HOME = home;
  });
  afterEach(() => {
    process.env.HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  });

  function seed(dir: string, data: unknown) {
    mkdirSync(join(dir, ".code-shell"), { recursive: true });
    writeFileSync(join(dir, ".code-shell", "settings.json"), JSON.stringify(data), "utf-8");
  }

  test("project capabilityOverrides 'on' removes a globally-disabled plugin", () => {
    seed(home, { disabledPlugins: ["chrome-devtools", "other"] });
    seed(cwd, { capabilityOverrides: { plugins: { "chrome-devtools": "on" } } });
    const r = computeEffectiveDisabledLists(new SettingsManager(cwd, "full"), cwd);
    expect(r.disabledPlugins).toEqual(["other"]);
  });

  test("project 'off' adds a plugin the global list doesn't name", () => {
    seed(home, { disabledPlugins: [] });
    seed(cwd, { capabilityOverrides: { plugins: { noisy: "off" } } });
    const r = computeEffectiveDisabledLists(new SettingsManager(cwd, "full"), cwd);
    expect(r.disabledPlugins).toContain("noisy");
  });

  test("no project overlay → global baseline unchanged", () => {
    seed(home, { disabledPlugins: ["a"], disabledSkills: ["s"] });
    const r = computeEffectiveDisabledLists(new SettingsManager(cwd, "full"), cwd);
    expect(r.disabledPlugins).toEqual(["a"]);
    expect(r.disabledSkills).toEqual(["s"]);
  });

  test("pluginHooks 'off' keys surface as disabledPluginHooks", () => {
    seed(home, {});
    seed(cwd, {
      capabilityOverrides: {
        pluginHooks: { "p:SessionStart:echo hi": "off", "p:Stop:x": "on" },
      },
    });
    const r = computeEffectiveDisabledLists(new SettingsManager(cwd, "full"), cwd);
    expect(r.disabledPluginHooks).toEqual(["p:SessionStart:echo hi"]);
  });

  test("an explicit session profile replaces the Workspace profile while user overrides still win", () => {
    seed(home, { disabledPlugins: ["session-plugin", "manual-off"] });
    seed(cwd, {
      profile: { active: "workspace", overrides: { plugins: { "workspace-plugin": "on" } } },
      capabilityOverrides: { plugins: { "manual-off": "off" } },
    });
    const r = computeEffectiveDisabledLists(new SettingsManager(cwd, "full"), cwd, {
      plugins: { "session-plugin": "on", "manual-off": "on" },
    });
    expect(r.disabledPlugins).not.toContain("session-plugin");
    expect(r.disabledPlugins).toContain("manual-off");
    expect(r.disabledPlugins).not.toContain("workspace-plugin");
  });
});
