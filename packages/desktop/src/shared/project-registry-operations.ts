import type { LocalProject, ProjectCwdResolution } from "../preload/project-authority-types.js";

export interface ProjectRegistryOperations {
  "projects/restoreHistoricalCwd": { input: { cwd: string }; result: ProjectCwdResolution };
  "projects/remove": { input: { projectId: string }; result: void };
  "projects/removeRoot": {
    input: { projectId: string; rootId: string; path: string; observedIds: string[] };
    result: LocalProject;
  };
  "projects/createPicked": { input: { pickedPath: string }; result: LocalProject };
  "projects/addPickedRoot": {
    input: { projectId: string; pickedPath: string };
    result: { project: LocalProject; folded?: { picked: string; root: string } };
  };
  "projects/setPrimary": { input: { projectId: string; rootId: string }; result: LocalProject };
  "projects/rename": { input: { projectId: string; name: string }; result: LocalProject };
  "projects/setPinned": { input: { projectId: string; pinned: boolean }; result: LocalProject };
}
export type ProjectRegistryCommand = keyof ProjectRegistryOperations;
export const projectRegistryCommands = [
  "projects/restoreHistoricalCwd",
  "projects/remove",
  "projects/removeRoot",
  "projects/createPicked",
  "projects/addPickedRoot",
  "projects/setPrimary",
  "projects/rename",
  "projects/setPinned",
] as const satisfies readonly ProjectRegistryCommand[];
export function isProjectRegistryCommand(value: string): value is ProjectRegistryCommand {
  return projectRegistryCommands.some((name) => name === value);
}
