import { useCallback, useEffect, useRef, useState } from "react";

export interface PanelWorkspaceState {
  root: string | null;
  kind: "main" | "worktree" | null;
  ready: boolean;
  error?: string;
}

function immediateState(
  engineSessionId: string | null,
  repoPath: string | null,
): PanelWorkspaceState {
  if (!repoPath) return { root: null, kind: null, ready: true };
  if (!engineSessionId) return { root: repoPath, kind: "main", ready: true };
  return { root: null, kind: null, ready: false };
}

/**
 * Resolve the workspace owned by one persistent panel bucket. The engine
 * session, not the currently active repository, is the source of truth: a
 * hidden bucket may belong to a session that is still attached to a worktree.
 */
export function usePanelWorkspaceRoot(
  engineSessionId: string | null,
  repoPath: string | null,
): PanelWorkspaceState {
  const [workspace, setWorkspace] = useState<PanelWorkspaceState>(() =>
    immediateState(engineSessionId, repoPath),
  );
  const requestIdRef = useRef(0);
  const targetKey = `${engineSessionId ?? ""}\0${repoPath ?? ""}`;
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
    if (!repoPath || !engineSessionId) {
      setWorkspace(immediateState(engineSessionId, repoPath));
      return;
    }

    // Clear a previous bucket immediately. During a workspace-changed refresh
    // we retain the current root so long-lived Terminal/Browser bodies stay
    // mounted until main returns the replacement root.
    setWorkspace((current) =>
      current.root && targetKeyRef.current === requestTargetKey
        ? { ...current, ready: false, error: undefined }
        : { root: null, kind: null, ready: false },
    );
    try {
      const next = await window.codeshell.getSessionWorkspace(engineSessionId, repoPath);
      if (requestIdRef.current !== requestId || targetKeyRef.current !== requestTargetKey) return;
      setWorkspace({ root: next.root, kind: next.kind, ready: true });
    } catch (error) {
      if (requestIdRef.current !== requestId || targetKeyRef.current !== requestTargetKey) return;
      setWorkspace({
        root: repoPath,
        kind: "main",
        ready: true,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }, [engineSessionId, repoPath, targetKey]);

  useEffect(() => {
    void refresh();
    return () => {
      requestIdRef.current += 1;
    };
  }, [refresh]);

  useEffect(() => {
    const subscribe = window.codeshell.onWorkspaceChanged;
    if (typeof subscribe !== "function" || !engineSessionId || !repoPath) return;
    return subscribe((event) => {
      if (event.sessionId === engineSessionId) void refresh();
    });
  }, [engineSessionId, refresh, repoPath]);

  return workspace;
}
