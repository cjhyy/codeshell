import type { WorkspaceProfile } from "@cjhyy/code-shell-core";
import type { CodeshellApi } from "../preload/types.js";
import type {
  ProfileSwitchTarget,
  ProfileCredentialQuestion,
  ProfileCredentialAnswers,
} from "./profile-switch-authority.js";
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
export interface ProfilePackageOperations {
  "profiles/addRepo": { input: { repo: string }; result: Result<"addProfileRepo"> };
  "profiles/previewRequirements": {
    input: { name: string; target: RendererConfigurationTarget };
    result: Result<"previewProfileRequirements">;
  };
  "profiles/installRequirements": {
    input: { name: string; target: RendererConfigurationTarget };
    result: Result<"installProfileRequirements">;
  };
}
/** Native-owned inputs never enter the workbench capability list. */
export type ProfileWorkerReads = ProfileLibraryReads & {
  "profiles/switchSourceQuestions": {
    params: { target: ProfileSwitchTarget };
    result: ProfileCredentialQuestion[];
  };
  "profiles/previewSwitch": {
    params: { target: ProfileSwitchTarget; name: string | null; answers: ProfileCredentialAnswers };
    result: { status: "ready"; preview: Result<"previewProfileSwitch"> } | { status: "changed" };
  };
};
export function isProfileWorkerRead(name: string): name is keyof ProfileWorkerReads {
  return (
    isProfileLibraryRead(name) ||
    name === "profiles/switchSourceQuestions" ||
    name === "profiles/previewSwitch"
  );
}
export interface ProfileLibraryChanges {
  "profiles/adoptSwitch": {
    input: {
      target: ProfileSwitchTarget;
      name: string | null;
      answers: ProfileCredentialAnswers;
      expectedRevision: string;
    };
    result: Result<"adoptProfileSwitch">;
  };
  "profiles/activate": {
    input: { target: RendererConfigurationTarget; name: string };
    result: void;
  };
  "profiles/deactivate": { input: { target: RendererConfigurationTarget }; result: void };
  "profiles/setSession": {
    input: { sessionId: string; profileName: string };
    result: { persisted: boolean };
  };
  "profiles/forceDelete": {
    input: Target & { name: string };
    result: Result<"forceDeleteProfile">;
  };
  "profiles/delete": {
    input: Target & { name: string; clearActiveProject?: boolean };
    result: void;
  };
  "profiles/removeRepo": { input: { repo: string }; result: void };
  "profiles/exportRepo": {
    input: { names: string[]; path: string };
    result: { ok: true; written: string[] };
  };
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
  "profiles/adoptSwitch",
  "profiles/activate",
  "profiles/deactivate",
  "profiles/setSession",
  "profiles/forceDelete",
  "profiles/delete",
  "profiles/removeRepo",
  "profiles/exportRepo",
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
export type ProfileLibraryOperations = ProfilePackageOperations &
  ProfileLibraryChanges & {
    [K in keyof ProfileWorkerReads]: {
      input: ProfileWorkerReads[K]["params"];
      result: ProfileWorkerReads[K]["result"];
    };
  };
