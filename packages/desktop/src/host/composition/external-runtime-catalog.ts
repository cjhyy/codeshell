import { hostRuntimePath } from "../runtime-path.js";
import { isFeatureEnabled } from "@cjhyy/code-shell-core/extension";
import { readUserFeatureFlags } from "../../main/capability-modules-env.js";
import { availableExternalRuntimes } from "../../main/external-runtime-availability.js";
import { ExternalRuntimeModelService } from "../../main/external-runtime-model-service.js";
import { resolveNoRepoCwd } from "../../main/no-repo-cwd.js";
import type { BusinessMethods } from "./business-calls.js";

/** One discovery cache for Desktop, Quick Chat and mobile. The host resolves and
 * launches the local CLI using the trusted path from Desktop startup. */
export function externalRuntimeCatalogOperations() {
  const isEnabled = () =>
    isFeatureEnabled(readUserFeatureFlags(resolveNoRepoCwd()), "external_agent_runtime");
  const models = new ExternalRuntimeModelService({ isEnabled });
  return {
    async "external-runtime/available"({ searchPath }) {
      await hostRuntimePath.ready;
      return isEnabled() ? availableExternalRuntimes(hostRuntimePath.searchPath(searchPath)) : [];
    },
    async "external-runtime/models"({ searchPath }) {
      await hostRuntimePath.ready;
      return models.list(hostRuntimePath.searchPath(searchPath));
    },
  } satisfies Pick<BusinessMethods, "external-runtime/available" | "external-runtime/models">;
}
