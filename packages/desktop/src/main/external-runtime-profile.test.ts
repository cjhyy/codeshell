import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager, SettingsManager } from "@cjhyy/code-shell-core";
import {
  activateWorkspaceProfile,
  computeEffectiveDisabledLists,
  deleteWorkspaceProfile,
  saveWorkspaceProfile,
} from "@cjhyy/code-shell-core/internal";
import { readExternalRuntimeProfileOverrides } from "./external-runtime-profile.js";

let home: string;
let cwd: string;
let previousHome: string | undefined;
let sessions: SessionManager;
let settings: SettingsManager;
const sessionId = "external-live-profile-policy";

beforeEach(() => {
  previousHome = process.env.CODE_SHELL_HOME;
  home = mkdtempSync(join(tmpdir(), "codeshell-live-profile-"));
  process.env.CODE_SHELL_HOME = home;
  cwd = join(home, "workspace");
  mkdirSync(cwd);
  sessions = new SessionManager();
  sessions.create(cwd, "fixture-model", "fixture", sessionId);
  settings = new SettingsManager(cwd, "full");
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.CODE_SHELL_HOME;
  else process.env.CODE_SHELL_HOME = previousHome;
  rmSync(home, { recursive: true, force: true });
});

const read = (id = sessionId) =>
  readExternalRuntimeProfileOverrides({ sessionId: id, cwd, projectTrusted: true });

describe("external runtime live Profile overrides", () => {
  test("an unpinned Session retains the project's persisted exclusive capability snapshot", () => {
    saveWorkspaceProfile({
      basePreset: "general",
      name: "reviewer",
      label: "Reviewer",
      skills: ["review"],
      exclusiveCapabilities: true,
    });
    activateWorkspaceProfile(settings, "reviewer", cwd, { skills: ["review", "unrelated"] });
    expect(read()).toBeUndefined();
    expect(computeEffectiveDisabledLists(settings, cwd, read()).disabledSkills).toEqual([
      "unrelated",
    ]);
  });

  test("a pinned empty profile does not inherit the project default's capability switches", () => {
    saveWorkspaceProfile({
      basePreset: "general",
      name: "default-human",
      label: "Default",
      skills: ["global-off"],
    });
    saveWorkspaceProfile({ basePreset: "general", name: "empty-human", label: "Empty" });
    settings.saveUserSetting("disabledSkills", ["global-off"]);
    activateWorkspaceProfile(settings, "default-human", cwd);
    expect(computeEffectiveDisabledLists(settings, cwd, read()).disabledSkills).toEqual([]);
    sessions.updateSessionState(sessionId, { workspaceProfile: "empty-human" });
    expect(read()).toEqual({});
    expect(computeEffectiveDisabledLists(settings, cwd, read()).disabledSkills).toEqual([
      "global-off",
    ]);
  });

  test("Session pins stay isolated while project and local overrides keep their precedence", () => {
    saveWorkspaceProfile({
      basePreset: "general",
      name: "first-human",
      label: "First",
      skills: ["review"],
    });
    saveWorkspaceProfile({
      basePreset: "general",
      name: "second-human",
      label: "Second",
      plugins: ["research"],
    });
    sessions.updateSessionState(sessionId, { workspaceProfile: "first-human" });
    sessions.create(cwd, "fixture-model", "fixture", "other-session");
    sessions.updateSessionState("other-session", { workspaceProfile: "second-human" });
    expect(read()).toEqual({ skills: { review: "on" } });
    expect(read("other-session")).toEqual({ plugins: { research: "on" } });
    settings.saveProjectSetting("capabilityOverrides", { skills: { review: "off" } }, cwd);
    expect(computeEffectiveDisabledLists(settings, cwd, read()).disabledSkills).toContain("review");
    settings.saveLocalSetting("capabilityOverrides", { skills: { review: "on" } }, cwd);
    expect(computeEffectiveDisabledLists(settings, cwd, read()).disabledSkills).not.toContain(
      "review",
    );
  });

  test("a missing selected default or Session profile fails closed", () => {
    saveWorkspaceProfile({ basePreset: "general", name: "selected-human", label: "Selected" });
    activateWorkspaceProfile(settings, "selected-human", cwd);
    deleteWorkspaceProfile("selected-human");
    expect(read).toThrow(/unavailable/);
    sessions.updateSessionState(sessionId, { workspaceProfile: "missing-human" });
    expect(read).toThrow(/unavailable/);
    expect(() => read("missing-session")).toThrow(/unavailable/);
  });

  test("a worktree run can read the pin stored on its canonical main-root Session", () => {
    const worktree = join(home, "worktree");
    mkdirSync(worktree);
    saveWorkspaceProfile({
      basePreset: "general",
      name: "reviewer",
      label: "Reviewer",
      skills: ["review"],
    });
    sessions.updateSessionState(sessionId, { workspaceProfile: "reviewer" });
    expect(
      readExternalRuntimeProfileOverrides({ sessionId, cwd: worktree, projectTrusted: true }),
    ).toEqual({ skills: { review: "on" } });
  });
});
