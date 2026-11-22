import { SettingsManager } from "@cjhyy/code-shell-core";
import {
  credentialFileRevisionsMatch,
  withProfileCredentialRevisions,
  type StateStorage,
} from "@cjhyy/code-shell-core/internal/storage";
import { createLinkedFileSourceService } from "../../main/linked-file-sources-service.js";
import { getProjectStore } from "../../main/project-store.js";
import type { LinkedFileCommit, LinkedFileProject } from "../../shared/linked-file-sources.js";
import { claimBusinessCommit, type BusinessGrant } from "./business-calls.js";

function primaryProject(id: string): LinkedFileProject {
  const { project, mainRoot, cwd } = getProjectStore().resolveProjectRootByIdSync(id);
  return {
    projectId: project.id,
    rootId: mainRoot.id,
    cwd,
    canonicalIdentity: mainRoot.canonicalIdentity!,
  };
}

export interface LinkedFileWork {
  input: LinkedFileCommit;
  catalogPermit: Int32Array;
  settingsPermit: Int32Array;
}

/** Runs on the storage queue. Two durable resources each consume their own
 * document permit. Safe, shared catalog entries survive a failed settings write. */
export function commitLinkedFileSources(
  { input: { project, review, input }, catalogPermit, settingsPermit }: LinkedFileWork,
  primary = primaryProject,
) {
  const assertCurrent = () => {
    if (Atomics.load(settingsPermit, 0) !== 0) throw Error("文件引用窗口已关闭或导航。");
  };
  const assertProjectCurrent = () => {
    const current = primary(project.projectId);
    if (
      current.rootId !== project.rootId ||
      current.cwd !== project.cwd ||
      current.canonicalIdentity !== project.canonicalIdentity
    )
      throw Error("项目主目录已改变，请重新打开项目配置。");
  };
  const stale = () => Error("连接授权已改变，请刷新后重新选择。");
  const service = createLinkedFileSourceService({
    assertCurrent,
    assertProjectCurrent,
    resolveProject: async () => primary(project.projectId),
    snapshot: () => review,
    beforeCatalogCommit() {
      assertCurrent();
      assertProjectCurrent();
      if (!credentialFileRevisionsMatch(project.cwd, review.revisions)) throw stale();
      claimBusinessCommit(catalogPermit);
    },
    settings: (cwd) => ({
      mutateSettingsForScope(scope, path, mutate) {
        return withProfileCredentialRevisions(cwd, review.revisions, (areCurrent) =>
          new SettingsManager(cwd, "full").mutateSettingsForScope(scope, path, (current) => {
            assertProjectCurrent();
            if (!areCurrent()) throw stale();
            if (mutate(current) === false) return false;
            claimBusinessCommit(settingsPermit);
          }),
        );
      },
    }),
  });
  return service.add(project.projectId, input);
}

export function linkedFileSourceOperation(storage: Promise<Pick<StateStorage, "request">>) {
  return async (input: LinkedFileCommit, grant: BusinessGrant) => {
    const db = await storage;
    grant.assertCurrent();
    // A document may leave after the global catalog write and before the
    // project binding. Revocation must still prevent the second commit.
    const catalogPermit = new Int32Array(new SharedArrayBuffer(4));
    const revoke = () => {
      Atomics.compareExchange(catalogPermit, 0, 0, -1);
    };
    grant.signal.addEventListener("abort", revoke, { once: true });
    try {
      const result = await db.request<{ sourceIds: string[] }>("sources/addLinkedFiles", {
        input,
        catalogPermit,
        settingsPermit: grant.permit,
      } satisfies LinkedFileWork);
      if (!result) throw Error("文件引用存储不可用。");
      return result;
    } finally {
      grant.signal.removeEventListener("abort", revoke);
    }
  };
}
