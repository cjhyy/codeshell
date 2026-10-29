import React from "react";
import type { ManagedPanel } from "../../server/src/panels/types.js";
import { parseWorkbenchLocation, type WorkspaceSettingsSection } from "./website-routes.js";

export interface WorkbenchFileLocation {
  folder: string;
  path?: string;
  reveal?: boolean;
}
export interface WorkbenchLocation {
  view: ReturnType<typeof parseWorkbenchLocation>["view"] | "panel";
  section?: WorkspaceSettingsSection;
  panel?: ManagedPanel;
  preview?: string;
  files?: WorkbenchFileLocation;
}
const marker = "codeshellWorkbench";
const chat: WorkbenchLocation = { view: "chat" };
const initialLocation = (): WorkbenchLocation => parseWorkbenchLocation(new URL(location.href));

function parent(route: WorkbenchLocation): { label: string; route: WorkbenchLocation } | undefined {
  if (route.view === "panel")
    return route.preview
      ? { label: "返回面板", route: { ...route, preview: undefined } }
      : { label: "返回面板列表", route: { view: "panels" } };
  if (route.view === "files") {
    if (route.files?.path)
      return {
        label: "返回文件列表",
        route: { view: "files", files: { folder: route.files.folder } },
      };
    if (route.files?.folder)
      return {
        label: "返回上级文件夹",
        route: {
          view: "files",
          files: { folder: route.files.folder.split("/").slice(0, -1).join("/") },
        },
      };
  }
  if (route.view === "settings" && route.section && route.section !== "overview")
    return { label: "返回设置", route: { view: "settings", section: "overview" } };
  if (route.view !== "chat") return { label: "返回对话", route: chat };
}
const identity = (route: WorkbenchLocation) =>
  JSON.stringify([
    route.view,
    route.section ?? "overview",
    route.panel?.id,
    route.panel?.revision,
    route.preview,
    route.files?.folder ?? "",
    route.files?.path,
  ]);
const keepsPanel = (from: WorkbenchLocation, to: WorkbenchLocation) =>
  from.view === "panel" &&
  to.view === "panel" &&
  !!from.panel?.id &&
  from.panel.id === to.panel?.id &&
  from.panel.revision === to.panel.revision;

/** History holds opaque entry IDs only. Panel grants and file data stay in this mounted scope. */
export function useWorkbenchNavigation(workspace: string) {
  // A reload/remount must not mistake a previous instance's indexes for its own.
  // This is a navigation marker, not an authorization token (plain HTTP Hub is supported).
  const [mountId] = React.useState(
    () => window.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`,
  );
  const epoch = React.useRef(0);
  const [route, setRoute] = React.useState(initialLocation);
  const [dirty, setDirty] = React.useState(false);
  const [pending, setPending] = React.useState<(() => void) | null>(null);
  const current = React.useRef({ workspace, route, dirty });
  current.current = { workspace, route, dirty };
  const retiredOwners = React.useRef(new Set<string>());
  const approvedAction = React.useRef(false);
  const history = React.useRef<{
    owner: string;
    workspace: string;
    index: number;
    entries: Map<number, WorkbenchLocation>;
  } | null>(null);

  const write = React.useCallback((next: WorkbenchLocation, replace = false, force = false) => {
    const state = history.current;
    if (!state || state.workspace !== current.current.workspace) return;
    if (!replace && !force && identity(next) === identity(current.current.route)) return;
    if (!replace) {
      for (const key of state.entries.keys()) if (key > state.index) state.entries.delete(key);
      state.index++;
    }
    state.entries.set(state.index, next);
    // Old entries can still return to their safe URL-level page, never stale capabilities.
    if (state.entries.size > 100) state.entries.delete(Math.min(...state.entries.keys()));
    const url = new URL(location.href);
    if (next.view === "chat") url.searchParams.delete("view");
    else url.searchParams.set("view", next.view === "panel" ? "panels" : next.view);
    if (next.view === "settings" && next.section && next.section !== "overview")
      url.searchParams.set("section", next.section);
    else url.searchParams.delete("section");
    window.history[replace ? "replaceState" : "pushState"](
      { ...window.history.state, [marker]: { owner: state.owner, index: state.index } },
      "",
      url.pathname + url.search + url.hash,
    );
    current.current.route = next;
    setRoute(next);
  }, []);
  React.useLayoutEffect(() => {
    if (history.current) retiredOwners.current.add(history.current.owner);
    const next = history.current
      ? ({
          view: current.current.route.view === "panel" ? "panels" : current.current.route.view,
          section: current.current.route.section,
        } as WorkbenchLocation)
      : current.current.route;
    history.current = {
      owner: `${mountId}:${++epoch.current}`,
      workspace,
      index: 0,
      entries: new Map(),
    };
    setPending(null);
    setDirty(false);
    write(next, true);
  }, [mountId, workspace, write]);

  const guard = React.useCallback((action: () => void) => {
    const scope = current.current.workspace;
    const checked = () => {
      if (current.current.workspace === scope) action();
    };
    if (current.current.dirty && !approvedAction.current) setPending(() => checked);
    else checked();
  }, []);
  React.useEffect(() => {
    const pop = (event: PopStateEvent) => {
      const state = history.current;
      const destination = event.state?.[marker];
      if (!state) return;
      if (destination?.owner !== state.owner || !Number.isInteger(destination.index)) {
        if (retiredOwners.current.has(destination?.owner)) {
          // Workspace changes retire old in-memory targets. Consume no further Back action.
          write(current.current.route, true);
          return;
        }
        // An unowned entry belongs to the outer router/browser. Never push a trap entry.
        setPending(null);
        current.current.route = initialLocation();
        setRoute(current.current.route);
        return;
      }
      const target = destination.index as number;
      const next = state.entries.get(target) ?? initialLocation();
      if (target === state.index) return;
      if (current.current.dirty && !keepsPanel(current.current.route, next)) {
        const retained = current.current.route;
        const scope = state.workspace;
        // Child iframe history makes an app index difference an invalid browser
        // traversal distance. Restore this known page with a new opaque entry,
        // then commit the approved target directly; never leave an approval for
        // an unrelated future popstate. Cancelling discards this Forward branch.
        state.index = target;
        write(retained, false, true);
        setPending(() => () => {
          if (history.current === state && current.current.workspace === scope) write(next, true);
        });
        return;
      }
      setPending(null);
      state.index = target;
      current.current.route = next;
      setRoute(next);
    };
    window.addEventListener("popstate", pop);
    return () => window.removeEventListener("popstate", pop);
  }, [write]);
  const navigate = React.useCallback(
    (next: WorkbenchLocation) =>
      keepsPanel(current.current.route, next) ? write(next) : guard(() => write(next)),
    [guard, write],
  );
  const back = () => {
    const action = () => {
      const destination = parent(current.current.route);
      const state = history.current;
      if (!destination || !state) return;
      // An iframe can add joint history entries without a parent popstate.
      // Explicit parent navigation must finish synchronously, independent of
      // that unknown distance. Browser Back/Forward remains a separate action.
      write(destination.route, true);
    };
    const destination = parent(current.current.route);
    if (destination && keepsPanel(current.current.route, destination.route)) action();
    else guard(action);
  };
  return {
    route:
      history.current && history.current.workspace !== workspace
        ? { view: route.view === "panel" ? "panels" : route.view, section: route.section }
        : route,
    navigate,
    replace: (next: WorkbenchLocation) => write(next, true),
    back,
    backLabel: parent(route)?.label,
    dirty,
    setDirty,
    guard,
    pending,
    prompt: (action: () => void) => {
      const scope = current.current.workspace;
      setPending(() => () => {
        if (current.current.workspace === scope) action();
      });
    },
    stay: () => setPending(null),
    leave: () => {
      setPending(null);
      // Approval is for this navigation only. A retained Panel confirmation stays dirty.
      approvedAction.current = true;
      try {
        pending?.();
      } finally {
        approvedAction.current = false;
      }
    },
  };
}
