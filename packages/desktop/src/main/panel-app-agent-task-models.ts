// Shared with the standalone Web host; keep Desktop and Web task semantics identical.
export * from "@cjhyy/code-shell-server/panels";

import { isAbsolute } from "node:path";
import { SettingsManager } from "@cjhyy/code-shell-core";
import { getMergedCatalog } from "@cjhyy/code-shell-core/internal";
import { buildPanelAgentTaskModelCatalog } from "@cjhyy/code-shell-server/panels";
import { getTrust } from "./trust-store.js";

/** Only the native Panel binding supplies cwd. Both processes must agree before Core can apply trust-sensitive settings. */
export async function readPanelTaskModels({
  cwd,
  trustedAtDispatch,
}: {
  cwd: string;
  trustedAtDispatch: boolean;
}) {
  if (
    typeof cwd !== "string" ||
    !isAbsolute(cwd) ||
    cwd.includes("\0") ||
    typeof trustedAtDispatch !== "boolean"
  )
    throw Error("Invalid Panel workspace");
  const trusted = trustedAtDispatch && (await getTrust(cwd)) === "trusted";
  return buildPanelAgentTaskModelCatalog(
    new SettingsManager(cwd, "full", trusted).get(),
    getMergedCatalog(),
  );
}
