import {
  panelExecutionGate,
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

/** Prepare a lazy release callback; management validates the review before invoking it. */
export function panelUpdateApproval(
  appId: string,
  force: boolean | undefined,
  close: ClosePanelForUpdate,
) {
  return {
    overwrite: true,
    expectedId: appId,
    ...(force
      ? {
          releaseExecutions: (id: string, matches: (scope: PanelExecutionScope) => boolean) =>
            releasePanelForUpdate(id, matches, close),
        }
      : {}),
  };
}

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
 * After review validation and admission fencing: close matching holders, then wait for
 * their real exits. The update's final admission check reports anything left.
 */
export async function releasePanelForUpdate(
  appId: string,
  matches: (scope: PanelExecutionScope) => boolean,
  close: ClosePanelForUpdate,
  timeoutMs = 15_000,
): Promise<void> {
  await close(appId, matches);
  const deadline = Date.now() + timeoutMs;
  while (panelExecutionGate.blockers(matches).length && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 100));
}
