import type {
  ProjectMigrationTarget,
  MigratedSessionMainRoot,
  MigrateSessionMainRootOptions,
} from "../main/project-store.js";

type Owner = NonNullable<MigrateSessionMainRootOptions["owner"]>;
export type { ProjectMigrationTarget } from "../main/project-store.js";
export type ProjectMigrationOutcome = Awaited<ReturnType<Owner["migrate"]>>;

export interface ProjectMigrationOperations {
  "projects/prepareMigration": {
    input: { ticket: string; sessionId: string; targetRootId: string };
    result: ProjectMigrationTarget;
  };
  "projects/settleMigration": {
    input: {
      ticket: string;
      outcome: ProjectMigrationOutcome | { status: "response-lost"; message: string };
    };
    result: MigratedSessionMainRoot;
  };
  "projects/releaseMigration": { input: { ticket: string }; result: true };
  "projects/removalPath": { input: { projectId: string; rootId: string }; result: string };
}
export type ProjectMigrationCommand = keyof ProjectMigrationOperations;
export const projectMigrationCommands = [
  "projects/prepareMigration",
  "projects/settleMigration",
  "projects/releaseMigration",
  "projects/removalPath",
] as const satisfies readonly ProjectMigrationCommand[];
export function isProjectMigrationCommand(value: string): value is ProjectMigrationCommand {
  return projectMigrationCommands.some((command) => command === value);
}

export const rootMigrationRequestPrefix = "desktop-private-root-migration:";
export function isRootMigrationReply(message: unknown): boolean {
  if (!message || typeof message !== "object" || !("id" in message)) return false;
  return typeof message.id === "string" && message.id.startsWith(rootMigrationRequestPrefix);
}
