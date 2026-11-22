import { claimBusinessCommit } from "../host/composition/business-calls.js";
import type {
  ProjectRegistryCommand,
  ProjectRegistryOperations,
} from "../shared/project-registry-operations.js";
import { getProjectStore, type ProjectStore } from "./project-store.js";
import { requireRendererProjectRoot } from "./renderer-project-path.js";
import { getTrust } from "./trust-store.js";

type ProjectEdits = {
  [K in ProjectRegistryCommand]: (
    input: ProjectRegistryOperations[K]["input"],
    commit?: () => void,
  ) => Promise<ProjectRegistryOperations[K]["result"]>;
};

export function projectRegistryEdits(store: ProjectStore, trust = getTrust): ProjectEdits {
  return {
    "projects/remove": ({ projectId }, commit) => store.remove(projectId, commit),
    "projects/removeRoot": ({ projectId, rootId, path, observedIds }, commit) =>
      store.removeRoot(projectId, rootId, commit, { path, ids: observedIds }),
    "projects/createPicked": ({ pickedPath }, commit) => store.createFromPath(pickedPath, commit),
    "projects/addPickedRoot": ({ projectId, pickedPath }, commit) =>
      store.addRoot(projectId, pickedPath, commit),
    async "projects/setPrimary"({ projectId, rootId }, commit) {
      const root = await requireRendererProjectRoot(projectId, rootId);
      if ((await trust(root.path)) !== "trusted")
        throw new Error("project root must be trusted before it can become primary");
      return store.setPrimary(projectId, rootId, commit);
    },
    "projects/rename": ({ projectId, name }, commit) => store.rename(projectId, name, commit),
    "projects/setPinned": ({ projectId, pinned }, commit) =>
      store.setPinned(projectId, pinned, commit),
  };
}

export async function writeHostedProjectRegistry<K extends ProjectRegistryCommand>(
  command: K,
  payload: { input: ProjectRegistryOperations[K]["input"]; permit: Int32Array },
) {
  const store = getProjectStore();
  const result = await projectRegistryEdits(store)[command](payload.input, () =>
    claimBusinessCommit(payload.permit),
  );
  return { result, projects: await store.list() };
}
