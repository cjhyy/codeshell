import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeEffectiveDisabledLists } from "../capability-control/disabled-lists.js";
import { registerConfiguredHooks } from "../hooks/register-configured-hooks.js";
import { HookRegistry } from "../hooks/registry.js";
import { SettingsManager } from "../settings/manager.js";
import type { CapabilityOverrides } from "../settings/schema.js";
import { loadPluginHooks, pluginHookKey, type PluginHookDisablePolicy } from "./loadPluginHooks.js";
import { pluginHooksDigest } from "./pluginHookIntegrity.js";

const originalHome = process.env.HOME;
const command =
  `printf x >> "$CODESHELL_PLUGIN_ROOT/invocations"; ` +
  `printf '%s' '{"additionalContext":"hook-fired"}'`;
const hookKey = pluginHookKey({ plugin: "guard", rawEvent: "PreToolUse", command });
let home: string;
let cwd: string;
let installPath: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "plugin-hook-live-policy-"));
  process.env.HOME = home;
  cwd = join(home, "project");
  installPath = join(home, "plugin-guard");
  mkdirSync(join(cwd, ".code-shell"), { recursive: true });
  mkdirSync(join(installPath, "hooks"), { recursive: true });
  writeFileSync(join(installPath, "invocations"), "");
});

afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  rmSync(home, { recursive: true, force: true });
});

function stagePlugin(approved = true): void {
  writeFileSync(
    join(installPath, "hooks", "hooks.json"),
    JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type: "command", command }] }] } }),
  );
  const digest = pluginHooksDigest(installPath);
  const pluginsDir = join(home, ".code-shell", "plugins");
  mkdirSync(pluginsDir, { recursive: true });
  writeFileSync(
    join(pluginsDir, "installed_plugins.json"),
    JSON.stringify({
      version: 2,
      plugins: {
        "guard@market": [
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

function invocationCount(): number {
  return readFileSync(join(installPath, "invocations"), "utf8").length;
}

describe("plugin hook live disable policy", () => {
  test.each(["plugin", "hook"] as const)(
    "an initially disabled %s can be enabled and disabled without rebuilding",
    async (kind) => {
      stagePlugin();
      const disabled: PluginHookDisablePolicy = {
        disabledPlugins: kind === "plugin" ? ["guard"] : [],
        disabledPluginHooks: kind === "hook" ? [hookKey] : [],
      };
      let policy = disabled;
      const registry = new HookRegistry();
      loadPluginHooks(
        registry,
        disabled.disabledPlugins,
        disabled.disabledPluginHooks,
        undefined,
        () => policy,
      );

      expect(registry.hasHooks("pre_tool_use")).toBe(true);
      expect(await registry.emit("pre_tool_use", { toolName: "Read" })).toEqual({});
      expect(invocationCount()).toBe(0);

      policy = { disabledPlugins: [], disabledPluginHooks: [] };
      expect(await registry.emit("pre_tool_use", { toolName: "Read" })).toEqual({
        messages: ["hook-fired"],
      });
      expect(invocationCount()).toBe(1);

      policy = disabled;
      expect(await registry.emit("pre_tool_use", { toolName: "Read" })).toEqual({});
      expect(invocationCount()).toBe(1);
    },
  );

  test("a current policy read failure suppresses the process until policy is readable", async () => {
    stagePlugin();
    let unavailable = false;
    const registry = new HookRegistry();
    loadPluginHooks(registry, [], [], undefined, () => {
      if (unavailable) throw new Error("profile no longer readable");
      return { disabledPlugins: [], disabledPluginHooks: [] };
    });

    await registry.emit("pre_tool_use");
    expect(invocationCount()).toBe(1);
    unavailable = true;
    expect(await registry.emit("pre_tool_use")).toEqual({});
    expect(invocationCount()).toBe(1);
    unavailable = false;
    await registry.emit("pre_tool_use");
    expect(invocationCount()).toBe(2);
  });

  test("a live enabled policy does not register an unapproved plugin hook", async () => {
    stagePlugin(false);
    const registry = new HookRegistry();
    loadPluginHooks(registry, ["guard"], [], undefined, () => ({
      disabledPlugins: [],
      disabledPluginHooks: [],
    }));

    expect(registry.hasHooks("pre_tool_use")).toBe(false);
    expect(await registry.emit("pre_tool_use")).toEqual({});
    expect(invocationCount()).toBe(0);
  });

  test("configured hooks read each session Profile with live project and local overrides", async () => {
    stagePlugin();
    const register = (profileOverrides: CapabilityOverrides) => {
      const registry = new HookRegistry();
      registerConfiguredHooks(
        registry,
        new SettingsManager(cwd, "project", true),
        cwd,
        undefined,
        () => {
          const settings = new SettingsManager(cwd, "project", true);
          settings.load(undefined, { persistMigrations: false });
          return computeEffectiveDisabledLists(settings, cwd, profileOverrides);
        },
      );
      return registry;
    };
    const disabledProfile = register({ plugins: { guard: "off" } });
    const enabledProfile = register({ plugins: { guard: "on" } });

    expect(await disabledProfile.emit("pre_tool_use")).toEqual({});
    expect(invocationCount()).toBe(0);
    await enabledProfile.emit("pre_tool_use");
    expect(invocationCount()).toBe(1);

    writeFileSync(
      join(cwd, ".code-shell", "settings.json"),
      JSON.stringify({ capabilityOverrides: { plugins: { guard: "on" } } }),
    );
    await disabledProfile.emit("pre_tool_use");
    expect(invocationCount()).toBe(2);

    writeFileSync(
      join(cwd, ".code-shell", "settings.local.json"),
      JSON.stringify({ capabilityOverrides: { plugins: { guard: "off" } } }),
    );
    expect(await disabledProfile.emit("pre_tool_use")).toEqual({});
    expect(await enabledProfile.emit("pre_tool_use")).toEqual({});
    expect(invocationCount()).toBe(2);

    writeFileSync(
      join(cwd, ".code-shell", "settings.local.json"),
      JSON.stringify({ capabilityOverrides: { pluginHooks: { [hookKey]: "off" } } }),
    );
    expect(await enabledProfile.emit("pre_tool_use")).toEqual({});
    expect(invocationCount()).toBe(2);

    writeFileSync(join(cwd, ".code-shell", "settings.local.json"), "{}");
    await disabledProfile.emit("pre_tool_use");
    expect(invocationCount()).toBe(3);
  });
});
