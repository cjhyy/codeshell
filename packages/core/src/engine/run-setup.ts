import type { ComposerOptions } from "../prompt/composer.js";
import { profileOverridesFromDefinition } from "../profile/activation.js";
import { resolveActiveWorkspaceProfile } from "../profile/resolve.js";
import { workspaceProfileDir } from "../profile/store.js";
import type { WorkspaceProfile } from "../profile/types.js";
import type { SettingsManager } from "../settings/manager.js";
import { buildSourcesContextSummary } from "../sources/context-summary.js";

export interface RunProfileState {
  workspaceProfile: ReturnType<typeof resolveActiveWorkspaceProfile>;
  sessionProfileOverrides: ReturnType<typeof profileOverridesFromDefinition> | undefined;
  profileMemoryDir: string | undefined;
}

/** Resolve the digital-human profile bound to this run (session pin wins). */
export function resolveRunProfileState(args: {
  sessionWorkspaceProfile: string | undefined;
  cwd: string;
  settings: SettingsManager;
}): RunProfileState {
  const { sessionWorkspaceProfile, cwd, settings } = args;
  const workspaceProfile = resolveActiveWorkspaceProfile({
    ...(sessionWorkspaceProfile ? { sessionProfile: sessionWorkspaceProfile } : {}),
    cwd,
    settings,
  });
  if (sessionWorkspaceProfile && !workspaceProfile) {
    throw new Error(`Workspace profile "${sessionWorkspaceProfile}" is unavailable`);
  }
  const sessionProfileOverrides =
    sessionWorkspaceProfile && workspaceProfile
      ? profileOverridesFromDefinition(workspaceProfile)
      : undefined;
  const profileMemoryDir = workspaceProfile?.portableMemory
    ? workspaceProfileDir(workspaceProfile.name)
    : undefined;
  return { workspaceProfile, sessionProfileOverrides, profileMemoryDir };
}

export interface RunPromptComposerConfigInput {
  cwd: ComposerOptions["cwd"];
  model: ComposerOptions["model"];
  preset: ComposerOptions["preset"];
  customSystemPrompt: ComposerOptions["customSystemPrompt"];
  appendSystemPrompt: ComposerOptions["appendSystemPrompt"];
  responseLanguage: ComposerOptions["responseLanguage"];
  userProfile: ComposerOptions["userProfile"];
  workspaceProfile: WorkspaceProfile | undefined;
  profileMemoryDir: ComposerOptions["profileMemoryDir"];
  instructionCompatFileNames: NonNullable<
    NonNullable<ComposerOptions["instructionOptions"]>["compatFileNames"]
  >;
  instructionBoundaryFinder: NonNullable<
    NonNullable<ComposerOptions["instructionOptions"]>["boundaryFinder"]
  >;
  disabledSkills: ComposerOptions["disabledSkills"];
  disabledPlugins: ComposerOptions["disabledPlugins"];
  skillAllowlist: ComposerOptions["skillAllowlist"];
  memoriesMaxAgeDays: ComposerOptions["memoriesMaxAgeDays"];
  goalToolState: ComposerOptions["goalToolState"];
  capabilityPromptSections: ComposerOptions["capabilityPromptSections"];
  dynamicContextProviders: ComposerOptions["dynamicContextProviders"];
  getSettingsManager: () => SettingsManager;
  toolCatalog: ComposerOptions["toolCatalog"];
}

/** Build the prompt-composer options for a run without capturing the Engine facade. */
export function buildPromptComposerConfig(args: RunPromptComposerConfigInput): ComposerOptions {
  const {
    cwd,
    model,
    preset,
    customSystemPrompt,
    appendSystemPrompt,
    responseLanguage,
    userProfile,
    workspaceProfile,
    profileMemoryDir,
    instructionCompatFileNames,
    instructionBoundaryFinder,
    disabledSkills,
    disabledPlugins,
    skillAllowlist,
    memoriesMaxAgeDays,
    goalToolState,
    capabilityPromptSections,
    dynamicContextProviders,
    getSettingsManager,
    toolCatalog,
  } = args;

  return {
    cwd,
    model,
    preset,
    customSystemPrompt,
    appendSystemPrompt,
    responseLanguage,
    userProfile,
    // WorkspaceProfile（数字人）：mainInstruction 从库活读（settings 只记名字）。
    // 命名注意：engine 的局部变量 `profile` 已被 RunBehaviorProfile 占用。
    profileMainInstruction: workspaceProfile?.mainInstruction,
    profileMemoryDir,
    instructionOptions: {
      compatFileNames: instructionCompatFileNames,
      boundaryFinder: instructionBoundaryFinder,
    },
    disabledSkills,
    disabledPlugins,
    skillAllowlist,
    memoriesMaxAgeDays,
    goalToolState,
    capabilityPromptSections,
    dynamicContextProviders,
    sourcesContextProvider: () =>
      buildSourcesContextSummary({ cwd, settings: getSettingsManager() }),
    toolCatalog,
  };
}
