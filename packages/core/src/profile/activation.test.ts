import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SettingsManager } from "../settings/manager.js";
import {
  activateWorkspaceProfile,
  deactivateWorkspaceProfile,
  profileOverridesFromDefinition,
} from "./activation.js";
import { saveWorkspaceProfile } from "./store.js";

let home: string;
let cwd: string;
let prevHome: string | undefined;

function projectSettings(): Record<string, unknown> {
  return JSON.parse(readFileSync(join(cwd, ".code-shell", "settings.json"), "utf-8"));
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "cs-profile-act-"));
  cwd = join(home, "ws");
  mkdirSync(cwd, { recursive: true });
  prevHome = process.env.CODE_SHELL_HOME;
  process.env.CODE_SHELL_HOME = home;
  saveWorkspaceProfile({
    name: "seedance",
    label: "Seedance",
    basePreset: "general",
    plugins: ["seedance-pack"],
    skills: ["storyboard"],
    mcp: [],
    agents: ["director"],
    portableMemory: true,
  });
  saveWorkspaceProfile({
    name: "ui-designer",
    label: "UI 设计师",
    basePreset: "general",
    plugins: ["figma-pack"],
    skills: [],
    mcp: [],
    agents: [],
    portableMemory: false,
  });
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.CODE_SHELL_HOME;
  else process.env.CODE_SHELL_HOME = prevHome;
  rmSync(home, { recursive: true, force: true });
});

describe("workspace profile activation transaction", () => {
  test("expands declared capabilities into an 'on' override snapshot", () => {
    const overrides = profileOverridesFromDefinition({
      name: "x",
      label: "x",
      basePreset: "general",
      plugins: ["p1"],
      skills: ["s1"],
      mcp: [],
      agents: ["a1"],
      portableMemory: false,
    });
    expect(overrides).toEqual({
      plugins: { p1: "on" },
      skills: { s1: "on" },
      agents: { a1: "on" },
    });
  });

  test("activate writes the whole profile subtree into project settings", () => {
    const settings = new SettingsManager(cwd, "full");
    activateWorkspaceProfile(settings, "seedance", cwd);
    const saved = projectSettings();
    expect(saved.profile).toEqual({
      active: "seedance",
      preset: "general",
      overrides: {
        plugins: { "seedance-pack": "on" },
        skills: { storyboard: "on" },
        agents: { director: "on" },
      },
    });
  });

  test("switching replaces the subtree wholesale (old capabilities gone)", () => {
    const settings = new SettingsManager(cwd, "full");
    activateWorkspaceProfile(settings, "seedance", cwd);
    activateWorkspaceProfile(settings, "ui-designer", cwd);
    const saved = projectSettings() as {
      profile: { active: string; overrides: Record<string, unknown> };
    };
    expect(saved.profile.active).toBe("ui-designer");
    expect(saved.profile.overrides).toEqual({ plugins: { "figma-pack": "on" } });
  });

  test("deactivate removes the subtree and never touches user capabilityOverrides", () => {
    const settings = new SettingsManager(cwd, "full");
    settings.saveProjectSetting("capabilityOverrides", { skills: { "my-skill": "off" } }, cwd);
    activateWorkspaceProfile(settings, "seedance", cwd);
    deactivateWorkspaceProfile(settings, cwd);
    const saved = projectSettings();
    expect(saved.profile).toBeUndefined();
    expect(saved.capabilityOverrides).toEqual({ skills: { "my-skill": "off" } });
  });

  test("activating an unknown profile throws and leaves settings untouched", () => {
    const settings = new SettingsManager(cwd, "full");
    expect(() => activateWorkspaceProfile(settings, "nope", cwd)).toThrow(/nope/);
  });
});
