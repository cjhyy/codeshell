import type { OpenCliSessionRequest } from "../cc-room/types";

/**
 * A CC Room tab bound to a DriveAgent task page carries `cliTask`. Only that
 * tab renders the task; other CC Room tabs keep the ordinary session list.
 */
export interface CliTaskTab {
  id: string;
  kind: string;
  cliTask?: string;
}

/** Stable identity of a DriveAgent task request; undefined for plain room requests. */
export function cliTaskKey(request: OpenCliSessionRequest | undefined): string | undefined {
  return request?.jobId && request.sourceSessionId
    ? `${request.sourceSessionId}:${request.jobId}`
    : undefined;
}

/** The CLI request a given tab should render, if any. */
export function cliSessionForTab(
  tab: CliTaskTab,
  request: OpenCliSessionRequest | undefined,
): OpenCliSessionRequest | undefined {
  if (tab.kind !== "ccRoom") return request;
  const key = cliTaskKey(request);
  if (key) return tab.cliTask === key ? request : undefined;
  return tab.cliTask ? undefined : request;
}

/**
 * Where a task link opens: the tab already showing this task, else the task
 * tab (rebound to this task), else a new tab. It never takes over a CC Room
 * tab the user is using as the session list.
 */
export function placeCliTaskTab<T extends CliTaskTab>(
  tabs: T[],
  cliTask: string,
  newTab: T,
): { tabs: T[]; activeId: string } {
  const bound =
    tabs.find((t) => t.kind === "ccRoom" && t.cliTask === cliTask) ??
    tabs.find((t) => t.kind === "ccRoom" && t.cliTask);
  if (bound) {
    return {
      activeId: bound.id,
      tabs:
        bound.cliTask === cliTask
          ? tabs
          : tabs.map((t) => (t.id === bound.id ? { ...t, cliTask } : t)),
    };
  }
  if (tabs.some((t) => t.id === newTab.id)) return { tabs, activeId: newTab.id };
  return { tabs: [...tabs, { ...newTab, cliTask }], activeId: newTab.id };
}
