import { useCallback, useEffect, useRef, useState } from "react";

export interface PanelWorkspaceState {
  root: string | null;
  kind: "main" | "worktree" | null;
  mainRoot: string | null;
  mainRootId: string | null;
  projectId: string | null;
  ready: boolean;
  error?: string;
}

function immediateState(
  engineSessionId: string | null,
  projectPath: string | null,
): PanelWorkspaceState {
  if (!projectPath)
    return {
      root: null,
      kind: null,
      mainRoot: null,
      mainRootId: null,
      projectId: null,
      ready: true,
    };
  if (!engineSessionId)
    return {
      root: projectPath,
      kind: "main",
      mainRoot: projectPath,
      mainRootId: null,
      projectId: null,
      ready: true,
    };
  return {
    root: null,
    kind: null,
    mainRoot: null,
    mainRootId: null,
    projectId: null,
    ready: false,
  };
}

/**
 * Resolve the workspace owned by one persistent panel bucket. The engine
 * session, not the currently active repository, is the source of truth: a
 * hidden bucket may belong to a session that is still attached to a worktree.
 */
export function usePanelWorkspaceRoot(
  engineSessionId: string | null,
  projectPath: string | null,
): PanelWorkspaceState {
  const [workspace, setWorkspace] = useState<PanelWorkspaceState>(() =>
    immediateState(engineSessionId, projectPath),
  );
  const requestIdRef = useRef(0);
  const targetKey = `${engineSessionId ?? ""}\0${projectPath ?? ""}`;
  const targetKeyRef = useRef(targetKey);

  // Invalidate a pending request during render, before an older promise has a
  // chance to settle between this render and the new target's effect.
  if (targetKeyRef.current !== targetKey) {
    targetKeyRef.current = targetKey;
    requestIdRef.current += 1;
  }

  const refresh = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    const requestTargetKey = targetKey;
    if (!projectPath || !engineSessionId) {
      setWorkspace(immediateState(engineSessionId, projectPath));
      return;
    }

    // Clear a previous bucket immediately. During a workspace-changed refresh
    // we retain the current root so long-lived Terminal/Browser bodies stay
    // mounted until main returns the replacement root.
    setWorkspace((current) =>
      current.root && targetKeyRef.current === requestTargetKey
        ? { ...current, ready: false, error: undefined }
        : {
            root: null,
            kind: null,
            mainRoot: null,
            mainRootId: null,
            projectId: null,
            ready: false,
          },
    );
    try {
      const authorityApi = window.codeshell.getSessionWorkspaceAuthority;
      const authority =
        typeof authorityApi === "function" ? await authorityApi(engineSessionId) : undefined;
      if (authority && authority.rootStatus !== "ok") {
        if (requestIdRef.current !== requestId || targetKeyRef.current !== requestTargetKey) return;
        setWorkspace({
          root: null,
          kind: null,
          mainRoot: authority.mainRoot,
          mainRootId: authority.mainRootId,
          projectId: authority.projectId,
          ready: true,
          error:
            authority.rootStatusMessage ??
            `Session root status ${authority.rootStatus}: repair required`,
        });
        return;
      }
      const next =
        authority?.workspace ??
        (await window.codeshell.getSessionWorkspace(engineSessionId, projectPath));
      if (requestIdRef.current !== requestId || targetKeyRef.current !== requestTargetKey) return;
      setWorkspace({
        root: next.root,
        kind: next.kind,
        mainRoot: authority?.mainRoot ?? projectPath,
        mainRootId: authority?.mainRootId ?? null,
        projectId: authority?.projectId ?? null,
        ready: true,
      });
    } catch (error) {
      if (requestIdRef.current !== requestId || targetKeyRef.current !== requestTargetKey) return;
      setWorkspace({
        root: null,
        kind: null,
        mainRoot: null,
        mainRootId: null,
        projectId: null,
        ready: true,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }, [engineSessionId, projectPath, targetKey]);

  useEffect(() => {
    void refresh();
    return () => {
      requestIdRef.current += 1;
    };
  }, [refresh]);

  useEffect(() => {
    const subscribe = window.codeshell.onWorkspaceChanged;
    if (typeof subscribe !== "function" || !engineSessionId || !projectPath) return;
    return subscribe((event) => {
      if (event.sessionId === engineSessionId) void refresh();
    });
  }, [engineSessionId, refresh, projectPath]);

  return workspace;
}
