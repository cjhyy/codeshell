import type { ToolContext } from "@cjhyy/code-shell-core/extension";
import type { AgentBridge } from "./agent-bridge.js";

/** Bind external-runtime tools to the same session-owned Host seams as native tools. */
export function externalRuntimeToolContextForSession(
  bridge: Pick<AgentBridge, "panelBridgeForSession" | "injectCredentialForSession">,
  sessionId: string,
  browser: ToolContext["browser"],
): Pick<ToolContext, "panels" | "browser" | "injectCredentialToBrowser"> {
  return {
    panels: bridge.panelBridgeForSession(sessionId),
    browser,
    injectCredentialToBrowser: (credentialId, scope, expectedApprovalIdentity) =>
      bridge.injectCredentialForSession(sessionId, credentialId, scope, expectedApprovalIdentity),
  };
}
