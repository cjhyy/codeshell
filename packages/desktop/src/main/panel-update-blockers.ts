import { resolvePanelAppBindingProjectPath } from "@cjhyy/code-shell-core";
import {
  panelExecutionGate,
  panelPackageMutationMatches,
  PanelExecutionBusyError,
  type PanelExecutionScope,
} from "@cjhyy/code-shell-server/panels";
import type { PanelAppChangeBlocker } from "../shared/panel-apps.js";

export type DescribePanelGuest = (
  guestId: number,
) => { tabId?: string; bucket?: string; sessionId?: string } | undefined;
export type ClosePanelForUpdate = (
  appId: string,
  matches: (scope: PanelExecutionScope) => boolean,
) => Promise<void>;

/** Result fields for a refused Panel change; empty unless executions hold it. */
export function panelChangeFailure(
  error: unknown,
  describeGuest: DescribePanelGuest,
): { blockers?: PanelAppChangeBlocker[] } {
  const blockers = panelChangeBlockers(error, describeGuest);
  return blockers ? { blockers } : {};
}

/** What holds a refused Panel change, each open instance named by its tab and session. */
export function panelChangeBlockers(
  error: unknown,
  describeGuest: DescribePanelGuest,
): PanelAppChangeBlocker[] | undefined {
  if (!(error instanceof PanelExecutionBusyError) || !error.blockers.length) return undefined;
  return error.blockers.map((blocker) => {
    const holder = blocker.holder,
      guest = holder?.guestId === undefined ? undefined : describeGuest(holder.guestId);
    return {
      kind: holder?.kind ?? "panel-call",
      count: blocker.count,
      ...(holder?.label ? { label: holder.label } : {}),
      ...guest,
    };
  });
}

/**
 * Before a forced update: close what would hold the update in `cwd`, then wait for those
 * executions to actually exit. The update's own admission check reports anything left.
 */
export async function releasePanelForUpdate(
  appId: string,
  cwd: string,
  close: ClosePanelForUpdate,
  timeoutMs = 15_000,
): Promise<void> {
  // The same executions the update's admission check would wait for.
  const matches = panelPackageMutationMatches({
    appId,
    kind: "update",
    projectPath: resolvePanelAppBindingProjectPath(cwd),
  });
  await close(appId, matches);
  const deadline = Date.now() + timeoutMs;
  while (panelExecutionGate.blockers(matches).length && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 100));
}
