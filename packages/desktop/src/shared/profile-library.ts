import type { WorkspaceProfile } from "@cjhyy/code-shell-core";
import type { CodeshellApi } from "../preload/types.js";
import type { DigitalHumanTeam } from "./digital-human-team.js";
import type { RendererConfigurationTarget } from "./renderer-configuration.js";
import type {
  DigitalHumanProfileImportCommitInput,
  DigitalHumanProfileImportPreview,
  DigitalHumanProfileImportCommitResult,
  DigitalHumanProfileExportResult,
} from "./digital-human-profile-transfer.js";

type Target = { target: RendererConfigurationTarget | null };
type Empty = Record<string, never>;
type Result<K extends keyof CodeshellApi> = CodeshellApi[K] extends (
  ...args: any[]
) => Promise<infer T>
  ? T
  : never;
export interface ProfileLibraryReads {
  "profiles/list": { params: Target; result: Result<"listProfiles"> };
  "profiles/catalog": { params: Empty; result: Result<"listProfileCatalog"> };
  "profiles/repos": { params: Empty; result: Result<"listProfileRepos"> };
  "profiles/teams": { params: Empty; result: DigitalHumanTeam[] };
  "profiles/previewDeletion": {
    params: Target & { name: string };
    result: Result<"previewProfileDeletion">;
  };
}
export const profileLibraryReads = [
  "profiles/list",
  "profiles/catalog",
  "profiles/repos",
  "profiles/teams",
  "profiles/previewDeletion",
] as const satisfies readonly (keyof ProfileLibraryReads)[];
export function isProfileLibraryRead(name: string): name is keyof ProfileLibraryReads {
  return profileLibraryReads.some((key) => key === name);
}
export interface ProfileLibraryChanges {
  "profiles/saveTeam": { input: { team: DigitalHumanTeam }; result: DigitalHumanTeam };
  "profiles/deleteTeam": { input: { id: string }; result: void };
  "profiles/save": { input: Target & { profile: WorkspaceProfile }; result: void };
  "profiles/install": { input: { name: string }; result: void };
  "profiles/pickedDefinition": {
    input: { path: string; owner: string };
    result: DigitalHumanProfileImportPreview;
  };
  "profiles/importDefinition": {
    input: Target & { owner: string } & DigitalHumanProfileImportCommitInput;
    result: DigitalHumanProfileImportCommitResult;
  };
  "profiles/exportDefinition": {
    input: { name: string; path: string };
    result: Exclude<DigitalHumanProfileExportResult, { canceled: true }>;
  };
}
export const profileLibraryChanges = [
  "profiles/saveTeam",
  "profiles/deleteTeam",
  "profiles/save",
  "profiles/install",
  "profiles/pickedDefinition",
  "profiles/importDefinition",
  "profiles/exportDefinition",
] as const satisfies readonly (keyof ProfileLibraryChanges)[];
export function isProfileLibraryChange(name: string): name is keyof ProfileLibraryChanges {
  return profileLibraryChanges.some((key) => key === name);
}
export type ProfileLibraryOperations = ProfileLibraryChanges & {
  [K in keyof ProfileLibraryReads]: {
    input: ProfileLibraryReads[K]["params"];
    result: ProfileLibraryReads[K]["result"];
  };
};
