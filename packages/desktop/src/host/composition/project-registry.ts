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
  return {
    "projects/createPicked": route("projects/createPicked"),
    "projects/addPickedRoot": route("projects/addPickedRoot"),
    "projects/setPrimary": route("projects/setPrimary"),
    "projects/rename": route("projects/rename"),
    "projects/setPinned": route("projects/setPinned"),
  } satisfies Pick<BusinessMethods, ProjectRegistryCommand>;
}
