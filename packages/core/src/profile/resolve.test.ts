import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SettingsManager } from "../settings/manager.js";
import { activateWorkspaceProfile } from "./activation.js";
import { resolveActiveWorkspaceProfile, workspaceProfilePresetFor } from "./resolve.js";
import { saveWorkspaceProfile } from "./store.js";

let home: string;
let cwd: string;
let prevHome: string | undefined;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "cs-profile-res-"));
  cwd = join(home, "ws");
  mkdirSync(cwd, { recursive: true });
  prevHome = process.env.CODE_SHELL_HOME;
  process.env.CODE_SHELL_HOME = home;
  saveWorkspaceProfile({
    name: "seedance",
    label: "Seedance",
    basePreset: "general",
    plugins: [],
    skills: [],
    mcp: [],
    agents: [],
    mainInstruction: "三阶段调度",
    portableMemory: true,
  });
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.CODE_SHELL_HOME;
  else process.env.CODE_SHELL_HOME = prevHome;
  rmSync(home, { recursive: true, force: true });
});

describe("resolveActiveWorkspaceProfile", () => {
  test("resolves the workspace default from project settings", () => {
    const settings = new SettingsManager(cwd, "full");
    activateWorkspaceProfile(settings, "seedance", cwd);
    const profile = resolveActiveWorkspaceProfile({ cwd, settings });
    expect(profile?.name).toBe("seedance");
    expect(profile?.mainInstruction).toBe("三阶段调度");
  });

  test("returns undefined when nothing is active", () => {
    const settings = new SettingsManager(cwd, "full");
    expect(resolveActiveWorkspaceProfile({ cwd, settings })).toBeUndefined();
  });

  test("sessionProfile (future per-session binding) wins over workspace default", () => {
    const settings = new SettingsManager(cwd, "full");
    saveWorkspaceProfile({
      name: "ui-designer",
      label: "UI",
      basePreset: "general",
      plugins: [],
      skills: [],
      mcp: [],
      agents: [],
      portableMemory: false,
    });
    activateWorkspaceProfile(settings, "seedance", cwd);
    const profile = resolveActiveWorkspaceProfile({
      sessionProfile: "ui-designer",
      cwd,
      settings,
    });
    expect(profile?.name).toBe("ui-designer");
  });

  test("active name pointing at a deleted library entry degrades to undefined", () => {
    const settings = new SettingsManager(cwd, "full");
    activateWorkspaceProfile(settings, "seedance", cwd);
    rmSync(join(home, "profiles", "seedance"), { recursive: true, force: true });
    expect(resolveActiveWorkspaceProfile({ cwd, settings })).toBeUndefined();
  });

  test("workspaceProfilePresetFor returns the snapshot preset", () => {
    const settings = new SettingsManager(cwd, "full");
    activateWorkspaceProfile(settings, "seedance", cwd);
    expect(workspaceProfilePresetFor(settings, cwd)).toBe("general");
    expect(workspaceProfilePresetFor(settings, join(home, "elsewhere"))).toBeUndefined();
  });
});
