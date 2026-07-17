import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const rendererRoot = join(import.meta.dir, "..");
const settingsI18n = readFileSync(join(rendererRoot, "i18n", "ns", "settings.ts"), "utf8");
const settingsPage = readFileSync(join(import.meta.dir, "SettingsPage.tsx"), "utf8");

describe("settings legacy cleanup", () => {
  test("retired settings shells are no longer shipped", () => {
    expect(existsSync(join(import.meta.dir, "SettingsView.tsx"))).toBe(false);
    expect(existsSync(join(import.meta.dir, "PluginsAndSkillsSection.tsx"))).toBe(false);
    expect(settingsPage).not.toContain("SettingsView");
    expect(settingsPage).not.toContain("PluginsAndSkillsSection");
  });

  test("retired shells do not leave dedicated translation namespaces behind", () => {
    expect(settingsI18n).not.toContain("\n      view: {");
    expect(settingsI18n).not.toContain("\n      plugins: {");
    expect(settingsI18n).not.toContain('scopeAria: "能力配置范围"');
    expect(settingsI18n).not.toContain('scopeAria: "Capability config scope"');
  });
});
