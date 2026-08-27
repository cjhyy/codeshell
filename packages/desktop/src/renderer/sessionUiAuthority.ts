import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { RendererConfigurationTarget, SessionWorkspaceAuthority } from "../preload/types";

export interface SessionUiAuthority {
  configurationTarget: RendererConfigurationTarget;
  configurationAvailable: boolean;
  mainRoot: string | null;
  mainRootId: string | null;
  workspaceRoot: string | null;
  projectId: string | null;
  rootStatus: SessionWorkspaceAuthority["rootStatus"] | "loading" | "unavailable";
  rootStatusMessage?: string;
}

interface Params {
  sessionId: string | null;
  projectId: string | null;
  projectPrimaryRoot: string | null;
  projectPrimaryRootId: string | null;
  projectAuthorityVersion: string;
  noRepoCwd: string | null;
  allowProjectFallback: boolean;
}

interface LoadedAuthority {
  requestKey: string;
  authority: SessionWorkspaceAuthority | null;
  error?: string;
}

function unavailableSessionAuthority(
  sessionId: string,
  status: "loading" | "unavailable",
  message?: string,
): SessionUiAuthority {
  return {
    configurationTarget: { sessionId },
    configurationAvailable: false,
    mainRoot: null,
    mainRootId: null,
    workspaceRoot: null,
    projectId: null,
    rootStatus: status,
    ...(message ? { rootStatusMessage: message } : {}),
  };
}

/**
 * The single renderer authority projection for the active conversation.
 *
 * Existing Sessions never inherit a renderer project path: Main resolves the
 * persisted Session binding and workspace. Drafts deliberately use the current
 * project primary (or Main-provided no-repo cwd) until a Session exists.
 */
export function useSessionUiAuthority({
  sessionId,
  projectId,
  projectPrimaryRoot,
  projectPrimaryRootId,
  projectAuthorityVersion,
  noRepoCwd,
  allowProjectFallback,
}: Params): SessionUiAuthority {
  const requestKey = sessionId ? `${sessionId}\0${projectAuthorityVersion}` : "";
  const [loaded, setLoaded] = useState<LoadedAuthority | null>(null);
  const requestIdRef = useRef(0);
  const requestKeyRef = useRef(requestKey);

  // Invalidate the old request during render. An earlier authority promise can
  // otherwise settle after the new target renders but before its effect runs.
  if (requestKeyRef.current !== requestKey) {
    requestKeyRef.current = requestKey;
    requestIdRef.current += 1;
  }

  const refresh = useCallback(async (): Promise<void> => {
    if (!sessionId) return;
    const requestId = ++requestIdRef.current;
    const requestTargetKey = requestKeyRef.current;
    try {
      const authority = await window.codeshell.getSessionWorkspaceAuthority(sessionId);
      if (requestIdRef.current !== requestId || requestKeyRef.current !== requestTargetKey) return;
      setLoaded({ requestKey: requestTargetKey, authority });
    } catch (error) {
      if (requestIdRef.current !== requestId || requestKeyRef.current !== requestTargetKey) return;
      setLoaded({
        requestKey: requestTargetKey,
        authority: null,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }, [requestKey, sessionId]);

  useEffect(() => {
    if (!sessionId) {
      requestIdRef.current += 1;
      setLoaded(null);
      return;
    }
    void refresh();
    return () => {
      requestIdRef.current += 1;
    };
  }, [refresh, sessionId]);

  useEffect(() => {
    const subscribe = window.codeshell.onWorkspaceChanged;
    if (!sessionId || typeof subscribe !== "function") return;
    return subscribe((event) => {
      if (event.sessionId === sessionId) void refresh();
    });
  }, [refresh, sessionId]);

  return useMemo(() => {
    const projectFallback = (): SessionUiAuthority => {
      if (projectId) {
        return {
          configurationTarget: { projectId },
          configurationAvailable: Boolean(projectPrimaryRoot),
          mainRoot: projectPrimaryRoot,
          mainRootId: projectPrimaryRootId,
          workspaceRoot: projectPrimaryRoot,
          projectId,
          rootStatus: projectPrimaryRoot ? "loading" : "unavailable",
        };
      }
      return {
        configurationTarget: { noRepo: true },
        configurationAvailable: Boolean(noRepoCwd),
        mainRoot: noRepoCwd,
        mainRootId: null,
        workspaceRoot: noRepoCwd,
        projectId: null,
        rootStatus: noRepoCwd ? "loading" : "unavailable",
      };
    };

    if (!sessionId) {
      if (projectId) {
        return {
          configurationTarget: { projectId },
          configurationAvailable: Boolean(projectPrimaryRoot),
          mainRoot: projectPrimaryRoot,
          mainRootId: projectPrimaryRootId,
          workspaceRoot: projectPrimaryRoot,
          projectId,
          rootStatus: projectPrimaryRoot ? "ok" : "unavailable",
        };
      }
      return {
        configurationTarget: { noRepo: true },
        configurationAvailable: Boolean(noRepoCwd),
        mainRoot: noRepoCwd,
        mainRootId: null,
        workspaceRoot: noRepoCwd,
        projectId: null,
        rootStatus: noRepoCwd ? "ok" : "loading",
      };
    }

    if (!loaded || loaded.requestKey !== requestKey) {
      if (allowProjectFallback) return projectFallback();
      return unavailableSessionAuthority(sessionId, "loading");
    }
    if (!loaded.authority) {
      if (allowProjectFallback) return projectFallback();
      return unavailableSessionAuthority(sessionId, "unavailable", loaded.error);
    }
    const authority = loaded.authority;
    if (authority.rootStatus !== "ok") {
      return {
        configurationTarget: { sessionId },
        configurationAvailable: false,
        mainRoot: null,
        mainRootId: authority.mainRootId,
        workspaceRoot: null,
        projectId: authority.projectId,
        rootStatus: authority.rootStatus,
        rootStatusMessage: authority.rootStatusMessage,
      };
    }
    return {
      configurationTarget: { sessionId },
      configurationAvailable: true,
      mainRoot: authority.mainRoot,
      mainRootId: authority.mainRootId,
      workspaceRoot: authority.workspace.root,
      projectId: authority.projectId,
      rootStatus: authority.rootStatus,
      rootStatusMessage: authority.rootStatusMessage,
    };
  }, [
    allowProjectFallback,
    loaded,
    noRepoCwd,
    projectId,
    projectPrimaryRoot,
    projectPrimaryRootId,
    requestKey,
    sessionId,
  ]);
}
