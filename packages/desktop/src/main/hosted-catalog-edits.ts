import { setCapabilityOverride, setCapabilityEnabled } from "./capabilities-service.js";
import { rendererConfigurationCwd } from "./renderer-configuration-helpers.js";
import {
  saveCatalogEntry,
  deleteUserCatalogEntry,
  userCatalogPath,
} from "@cjhyy/code-shell-core/internal";
import { claimBusinessCommit } from "../host/composition/business-calls.js";
import type { CatalogEdits, StoredCatalogEdit } from "../shared/catalog-edits.js";
import { requireRendererProjectPrimary } from "./renderer-project-path.js";
import {
  catalogSave,
  catalogDelete,
  bind,
  unbind,
  deleteUpload,
  commitStagedUploads,
  type StagedSourceUploads,
} from "./sources-service.js";
type Operations = {
  [K in StoredCatalogEdit]: (
    input: CatalogEdits[K]["input"],
    commit: () => void,
  ) => CatalogEdits[K]["result"] | Promise<CatalogEdits[K]["result"]>;
};
const catalogFile = (beforeCommit: () => void) => ({
  path: userCatalogPath(),
  stamp: String(Date.now()),
  beforeCommit,
});
const operations: Operations = {
  "capabilities/setEnabled": async ({ scope, target, id, on }, commit) => {
    if (
      (scope === "user" && target !== null) ||
      (scope === "project" && !target) ||
      !["project", "user"].includes(scope)
    )
      throw Error("Invalid capability scope");
    return setCapabilityEnabled(target ? await rendererConfigurationCwd(target) : "", id, on, {
      scope,
      beforeCommit: commit,
    });
  },
  "capabilities/setOverride": async ({ target, id, state }, commit) =>
    setCapabilityOverride(await rendererConfigurationCwd(target), id, state, commit),
  "models/saveEntry": ({ entry }, commit) => saveCatalogEntry(entry, catalogFile(commit)),
  "models/deleteEntry": ({ id }, commit) => deleteUserCatalogEntry(id, catalogFile(commit)),
  "sources/save": ({ definition }, commit) => catalogSave(definition, commit),
  "sources/delete": ({ id }, commit) => catalogDelete(id, commit),
  "sources/bind": async ({ projectId, binding }, commit) =>
    bind((await requireRendererProjectPrimary(projectId)).path, binding, commit),
  "sources/unbind": async ({ projectId, sourceId }, commit) =>
    unbind((await requireRendererProjectPrimary(projectId)).path, sourceId, commit),
  "sources/deleteUpload": async ({ projectId, name }, commit) =>
    deleteUpload((await requireRendererProjectPrimary(projectId)).path, name, commit),
};
export async function writeHostedCatalog<K extends StoredCatalogEdit>(
  name: K,
  { input, permit }: { input: CatalogEdits[K]["input"]; permit: Int32Array },
) {
  return { result: await operations[name](input, () => claimBusinessCommit(permit)) };
}

export async function commitPickedSourceUpload({
  projectId,
  staged,
  permit,
}: {
  projectId: string;
  staged: StagedSourceUploads;
  permit: Int32Array;
}) {
  const { path } = await requireRendererProjectPrimary(projectId);
  return commitStagedUploads(path, staged, () => claimBusinessCommit(permit));
}
