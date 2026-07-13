import React from "react";
import { usePanelWorkspaceRoot, type PanelWorkspaceState } from "./usePanelWorkspaceRoot";

export function panelWorkspaceBodyReady(workspace: PanelWorkspaceState): boolean {
  return workspace.ready || workspace.root !== null;
}

export function panelWorkspacePresentation(workspace: PanelWorkspaceState): {
  mountBody: boolean;
  showLoading: boolean;
} {
  return {
    mountBody: panelWorkspaceBodyReady(workspace),
    showLoading: !workspace.ready,
  };
}

/** Production boundary between PanelArea and its session-owned workspace resolver. */
export function PanelWorkspaceRootConsumer({
  engineSessionId,
  projectPath,
  children,
}: {
  engineSessionId: string | null;
  projectPath: string | null;
  children: (workspace: PanelWorkspaceState) => React.ReactNode;
}) {
  const workspace = usePanelWorkspaceRoot(engineSessionId, projectPath);
  return <>{children(workspace)}</>;
}
