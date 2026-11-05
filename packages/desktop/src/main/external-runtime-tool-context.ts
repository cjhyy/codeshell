import type { ToolContext } from "@cjhyy/code-shell-core/extension";
import type { AgentBridge } from "./agent-bridge.js";
import { legacySingleRootWorkspace } from "@cjhyy/code-shell-core/internal";
import { getProjectStore, type ProjectStore } from "./project-store.js";
import { getSessionCwdIndex, type SessionCwdIndex } from "./session-cwd-index.js";

/** Resolve the same mounted roots used to admit a native Session run. */
export function externalRuntimeWorkspaceForSession(
  sessionId: string,
  dependencies: {
    index: Pick<SessionCwdIndex, "refreshSync">;
    projects: Pick<ProjectStore, "resolveRunProjectSync" | "resolveExactRootSync">;
  } = { index: getSessionCwdIndex(), projects: getProjectStore() },
): NonNullable<ToolContext["workspace"]> {
  const session = dependencies.index.refreshSync(sessionId);
  if (!session) throw new Error("External runtime Session workspace is unavailable");
  const projectId =
    session.projectId ?? dependencies.projects.resolveExactRootSync(session.cwd)?.project.id;
  if (projectId) {
    return dependencies.projects.resolveRunProjectSync(
      projectId,
      sessionId,
      session,
      session.mainRootId,
    ).workspaceContext;
  }
  return legacySingleRootWorkspace(session.workspaceRoot ?? session.cwd);
}

/** Bind external-runtime tools to the same session-owned Host seams as native tools. */
export function externalRuntimeToolContextForSession(
  bridge: Pick<AgentBridge, "panelBridgeForSession" | "injectCredentialForSession">,
  sessionId: string,
  browser: ToolContext["browser"],
  workspace?: ToolContext["workspace"],
): Pick<ToolContext, "panels" | "browser" | "injectCredentialToBrowser" | "workspace"> {
  return {
    workspace,
    panels: bridge.panelBridgeForSession(sessionId),
    browser,
    injectCredentialToBrowser: (credentialId, scope, expectedApprovalIdentity) =>
      bridge.injectCredentialForSession(sessionId, credentialId, scope, expectedApprovalIdentity),
  };
}
