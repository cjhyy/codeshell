import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { activateWorkspaceProfile } from "../profile/activation.js";
import { saveWorkspaceProfile } from "../profile/store.js";
import type { WorkspaceProfile } from "../profile/types.js";
import { SettingsManager } from "../settings/manager.js";
import {
  buildPromptComposerConfig,
  resolveRunProfileState,
  type RunPromptComposerConfigInput,
} from "./run-setup.js";

let root: string;
let cwd: string;
let previousCodeShellHome: string | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "cs-run-setup-"));
  cwd = join(root, "workspace");
  mkdirSync(cwd, { recursive: true });
  previousCodeShellHome = process.env.CODE_SHELL_HOME;
  process.env.CODE_SHELL_HOME = join(root, "home");
});

afterEach(() => {
  if (previousCodeShellHome === undefined) delete process.env.CODE_SHELL_HOME;
  else process.env.CODE_SHELL_HOME = previousCodeShellHome;
  rmSync(root, { recursive: true, force: true });
});

function workspaceProfile(overrides: Partial<WorkspaceProfile> = {}): WorkspaceProfile {
  return {
    name: "researcher",
    label: "Researcher",
    basePreset: "general",
    plugins: [],
    skills: [],
    mcp: [],
    agents: [],
    portableMemory: false,
    ...overrides,
  };
}

function composerInput(
  overrides: Partial<RunPromptComposerConfigInput> = {},
): RunPromptComposerConfigInput {
  const settings = new SettingsManager(cwd, "isolated");
  return {
    cwd,
    model: "test-model",
    preset: undefined,
    customSystemPrompt: undefined,
    appendSystemPrompt: undefined,
    responseLanguage: undefined,
    userProfile: undefined,
    workspaceProfile: undefined,
    instructionCompatFileNames: ["CLAUDE.md", "AGENTS.md"],
    instructionBoundaryFinder: () => cwd,
    disabledSkills: [],
    disabledPlugins: [],
    skillAllowlist: undefined,
    memoriesMaxAgeDays: undefined,
    goalToolState: { hasGoal: false },
    capabilityPromptSections: {},
    dynamicContextProviders: [],
    getSettingsManager: () => settings,
    toolCatalog: [],
    ...overrides,
  };
}

describe("resolveRunProfileState", () => {
  test("throws when a session-pinned workspace profile is unavailable", () => {
    expect(() =>
      resolveRunProfileState({
        sessionWorkspaceProfile: "missing-profile",
        cwd,
        settings: new SettingsManager(cwd, "isolated"),
      }),
    ).toThrow('Workspace profile "missing-profile" is unavailable');
  });

  test("returns undefined overrides when the session has no pinned profile", () => {
    const settings = new SettingsManager(cwd, "project");
    saveWorkspaceProfile(workspaceProfile());
    activateWorkspaceProfile(settings, "researcher", cwd);
    const state = resolveRunProfileState({
      sessionWorkspaceProfile: undefined,
      cwd,
      settings,
    });

    expect(state.workspaceProfile?.name).toBe("researcher");
    expect(state.sessionProfileOverrides).toBeUndefined();
  });
});

describe("buildPromptComposerConfig", () => {
  test("maps portable profile instruction and memory directory", () => {
    const config = buildPromptComposerConfig(
      composerInput({
        workspaceProfile: workspaceProfile({
          mainInstruction: "Coordinate the research in three stages.",
          portableMemory: true,
        }),
      }),
    );

    expect(config.profileMainInstruction).toBe("Coordinate the research in three stages.");
    expect(config.profileMemoryDir).toBe(
      join(process.env.CODE_SHELL_HOME!, "profiles", "researcher"),
    );
  });

  test("leaves profile fields undefined without a workspace profile", () => {
    const config = buildPromptComposerConfig(composerInput());

    expect(config.profileMainInstruction).toBeUndefined();
    expect(config.profileMemoryDir).toBeUndefined();
  });

  test("does not mount profile memory when portableMemory is false", () => {
    const config = buildPromptComposerConfig(
      composerInput({
        workspaceProfile: workspaceProfile({
          mainInstruction: "Keep the instruction active.",
          portableMemory: false,
        }),
      }),
    );

    expect(config.profileMainInstruction).toBe("Keep the instruction active.");
    expect(config.profileMemoryDir).toBeUndefined();
  });

  test("passes explicit composer inputs through and resolves source settings lazily", () => {
    let settingsReads = 0;
    const boundaryFinder = () => root;
    const input = composerInput({
      customSystemPrompt: "custom",
      appendSystemPrompt: "append",
      responseLanguage: "Chinese",
      userProfile: "Ada",
      instructionCompatFileNames: ["CLAUDE.md"],
      instructionBoundaryFinder: boundaryFinder,
      disabledSkills: ["legacy-skill"],
      disabledPlugins: ["legacy-plugin"],
      skillAllowlist: ["approved-skill"],
      memoriesMaxAgeDays: 30,
      goalToolState: { hasGoal: true },
      capabilityPromptSections: { extra: "section" },
      getSettingsManager: () => {
        settingsReads += 1;
        return new SettingsManager(cwd, "isolated");
      },
    });

    const config = buildPromptComposerConfig(input);

    expect(config).toMatchObject({
      cwd,
      model: "test-model",
      customSystemPrompt: "custom",
      appendSystemPrompt: "append",
      responseLanguage: "Chinese",
      userProfile: "Ada",
      disabledSkills: ["legacy-skill"],
      disabledPlugins: ["legacy-plugin"],
      skillAllowlist: ["approved-skill"],
      memoriesMaxAgeDays: 30,
      goalToolState: { hasGoal: true },
      capabilityPromptSections: { extra: "section" },
    });
    expect(config.instructionOptions).toEqual({
      compatFileNames: ["CLAUDE.md"],
      boundaryFinder,
    });
    expect(settingsReads).toBe(0);
    expect(config.sourcesContextProvider?.()).toBe("");
    expect(settingsReads).toBe(1);
  });
});
