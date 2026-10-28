import type { PanelAppMutationFailure } from "./panel-apps.js";

/** Keep Host service/stop diagnostics visible on binding and uninstall failures. */
export function panelChangeErrorMessage(result: PanelAppMutationFailure): string {
  const details = new Set(result.blockers?.map((blocker) => blocker.label ?? blocker.kind));
  return [result.error, ...details].join("\n");
}
