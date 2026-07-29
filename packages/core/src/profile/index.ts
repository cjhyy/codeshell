export {
  SKILL_REPO_RE,
  WORKSPACE_PROFILE_NAME_RE,
  WorkspaceProfileRequirementsSchema,
  WorkspaceProfileSchema,
  type SkillRequirement,
  type ToolRequirement,
  type WorkspaceProfile,
  type WorkspaceProfileRequirements,
} from "./types.js";
export {
  CATALOG_REPO_RE,
  parseHumansManifest,
  readCatalogFromDir,
  sourceToRepoKey,
  type CatalogEntry as DigitalHumanCatalogSourceEntry,
  type CatalogTeam as DigitalHumanCatalogTeam,
  type HumansManifestTeam,
  type CatalogReadResult,
  type HumansManifest,
  type HumansManifestEntry,
} from "./catalog.js";
export {
  addHumanRepo,
  humanRepoDir,
  humanReposRoot,
  listHumanRepoDetails,
  listHumanRepos,
  readAllHumanRepoEntries,
  removeHumanRepo,
  type HumanRepoListEntry,
  type RegisteredHumanRepo,
} from "./catalog-store.js";
export {
  buildSkillInstallArgs,
  planProfileRequirements,
  summarizeSkillConflicts,
  type KnownSkill,
  type MissingTool,
  type PlannedSkillInstall,
  type ProfileRequirementPlan,
  type SkillConflict,
} from "./requirements.js";
export {
  deleteWorkspaceProfile,
  listWorkspaceProfiles,
  readWorkspaceProfile,
  saveWorkspaceProfile,
  workspaceProfileDir,
  workspaceProfilesRoot,
} from "./store.js";
export {
  activateWorkspaceProfile,
  deactivateWorkspaceProfile,
  profileOverridesFromDefinition,
  type InstalledCapabilityNames,
  type WorkspaceProfileSubtree,
} from "./activation.js";
export {
  resolveActiveWorkspaceProfile,
  workspaceProfilePresetFor,
  type ResolveActiveWorkspaceProfileInput,
} from "./resolve.js";
