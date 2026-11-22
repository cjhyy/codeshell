import { sessionsRoot } from "@cjhyy/code-shell-core";
import { SessionCwdIndex } from "../../main/session-cwd-index.js";
import type {
  ProjectMigrationCommand,
  ProjectMigrationOperations,
} from "../../shared/project-migration.js";
import type { StateStorage } from "@cjhyy/code-shell-core/internal/storage";
import type { LocalProject } from "../../preload/project-authority-types.js";
import type {
  ProjectRegistryCommand,
  ProjectRegistryOperations,
} from "../../shared/project-registry-operations.js";
import type { BusinessGrant, BusinessMethods } from "./business-calls.js";

export function projectRegistryOperations(
  storage: Promise<StateStorage>,
  changed: (id: string, projects: LocalProject[]) => void,
) {
  function route<K extends ProjectRegistryCommand>(command: K) {
    return async (input: ProjectRegistryOperations[K]["input"], grant: BusinessGrant) => {
      const db = await storage;
      grant.assertCurrent();
      const receipt = await db.request<{
        result: ProjectRegistryOperations[K]["result"];
        projects: LocalProject[];
      }>(command, { input, permit: grant.permit });
      if (!receipt) throw new Error("Project registry storage unavailable");
      changed(grant.requestId, receipt.projects);
      return receipt.result;
    };
  }
  function migration<K extends ProjectMigrationCommand>(command: K) {
    return async (input: ProjectMigrationOperations[K]["input"], grant: BusinessGrant) => {
      const db = await storage;
      grant.assertCurrent();
      const receipt = await db.request<{ value: ProjectMigrationOperations[K]["result"] }>(
        command,
        { input, permit: grant.permit },
      );
      if (!receipt) throw Error("Project registry storage unavailable");
      return receipt.value;
    };
  }
  return {
    "projects/prepareMigration": migration("projects/prepareMigration"),
    "projects/settleMigration": migration("projects/settleMigration"),
    "projects/releaseMigration": migration("projects/releaseMigration"),
    "projects/removalPath": migration("projects/removalPath"),
    "projects/remove": route("projects/remove"),
    async "projects/removeRoot"(input, grant) {
      // Other processes may have added a Session since either Desktop index was warmed.
      const disk = new SessionCwdIndex({ sessionsRoot: sessionsRoot(), scanAll: true });
      await disk.ensureLoaded();
      const observedIds = [
        ...new Set([
          ...input.observedIds,
          ...disk.confirmedIdsForProjectRoot(input.projectId, input.rootId, input.path),
        ]),
      ];
      return route("projects/removeRoot")({ ...input, observedIds }, grant);
    },
    "projects/createPicked": route("projects/createPicked"),
    "projects/addPickedRoot": route("projects/addPickedRoot"),
    "projects/setPrimary": route("projects/setPrimary"),
    "projects/rename": route("projects/rename"),
    "projects/setPinned": route("projects/setPinned"),
  } satisfies Pick<BusinessMethods, ProjectRegistryCommand | ProjectMigrationCommand>;
}
