import { requireRendererProjectPrimary } from "../../main/renderer-project-path.js";
import { stageSourceUploads, discardStagedUploads } from "../../main/sources-service.js";
import type { StateStorage } from "@cjhyy/code-shell-core/internal/storage";
import type { CatalogEdit, CatalogEdits } from "../../shared/catalog-edits.js";
import type { BusinessGrant, BusinessMethods } from "./business-calls.js";
export function catalogEdits(storage: Promise<StateStorage>) {
  function route<K extends CatalogEdit>(name: K) {
    return async (input: CatalogEdits[K]["input"], grant: BusinessGrant) => {
      const db = await storage;
      grant.assertCurrent();
      const reply = await db.request<{ result: CatalogEdits[K]["result"] }>(name, {
        input,
        permit: grant.permit,
      });
      if (!reply) throw new Error("Catalog storage unavailable");
      return reply.result;
    };
  }
  return {
    "capabilities/setEnabled": route("capabilities/setEnabled"),
    "capabilities/setOverride": route("capabilities/setOverride"),
    "models/saveEntry": route("models/saveEntry"),
    "models/deleteEntry": route("models/deleteEntry"),
    "sources/save": route("sources/save"),
    "sources/delete": route("sources/delete"),
    "sources/bind": route("sources/bind"),
    "sources/unbind": route("sources/unbind"),
    async "sources/uploadPicked"({ projectId, files }, grant) {
      const { path } = await requireRendererProjectPrimary(projectId);
      const staged = await stageSourceUploads(path, files, grant.assertCurrent);
      try {
        const db = await storage;
        grant.assertCurrent();
        const names = await db.request<string[]>("sources/commitPicked", {
          projectId,
          staged,
          permit: grant.permit,
        });
        if (!names) throw new Error("Upload storage unavailable");
        return names;
      } finally {
        discardStagedUploads(staged);
      }
    },
    "sources/deleteUpload": route("sources/deleteUpload"),
  } satisfies Pick<BusinessMethods, CatalogEdit>;
}
