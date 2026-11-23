import { createExternalRuntimeModule } from "../external-runtime-module.js";
import { externalRuntimeMimiHost } from "../external-runtime-mimi-tools.js";
import { createExternalRuntimeBackgroundWork } from "../external-runtime-background-work.js";
import type { BrowserWindow } from "electron";
import { SettingsManager } from "@cjhyy/code-shell-core";
import type { createDesktopHost } from "../desktop-host/main.js";
import type { AgentBridge } from "../agent-bridge.js";
import { getProjectStore } from "../project-store.js";
import { resolveNoRepoCwd } from "../no-repo-cwd.js";
import {
  beginBrowserRunForSession,
  interactiveBrowserBridgeForSession,
} from "../browser-runtime/index.js";
import {
  externalRuntimeToolContextForSession,
  externalRuntimeWorkspaceForSession,
} from "../external-runtime-tool-context.js";
import type { ExternalApprovalEvent } from "../external-runtime-approvals.js";

export function createNativeExternalRuntime(deps: {
  host: Pick<ReturnType<typeof createDesktopHost>, "inferExternalMemory" | "externalProviders">;
  bridge: () => AgentBridge;
  windows: Set<BrowserWindow>;
  onApproval(event: ExternalApprovalEvent): void;
  changed(sessionId: string, active: boolean, ownerId?: number): void;
  continued(id: string): void;
  notices: () => Parameters<typeof externalRuntimeMimiHost>[0];
}) {
  return createExternalRuntimeModule(() => {
    const externalBridge = deps.bridge();
    return {
      memoryInference: deps.host.inferExternalMemory,
      approvals: {
        windows: () => deps.windows,
        ownerWebContentsId: (sessionId) => externalBridge.panelOwnerWebContentsId(sessionId),
        onPendingChange: deps.onApproval,
      },
      service: {
        providerFactories: deps.host.externalProviders,
        featureFlags: () => {
          const cwd = resolveNoRepoCwd();
          const settings = new SettingsManager(cwd, "full").getForScope("user") as {
            featureFlags?: Record<string, boolean>;
          };
          return settings.featureFlags ?? {};
        },
        registerSession: (sessionId, cwd, webContentsId) =>
          externalBridge.registerExternalSession(sessionId, cwd, webContentsId),
        releaseSession: (sessionId) => externalBridge.releaseExternalSession(sessionId),
        resolveProjectBinding: (cwd) => {
          const resolved = getProjectStore().resolveExactRootSync(cwd);
          return resolved
            ? {
                projectId: resolved.project.id,
                mainRootId: resolved.mainRoot.id,
              }
            : undefined;
        },
        // Route events to the window that owns the session, not every window: a
        // second window showing a different session must not receive its stream.
        emit: (sessionId, event) => {
          externalBridge.ingestOwnedExternalEvent(sessionId, event);
        },
        sessionStateChanged: deps.changed,
        // The host seams the exposed tools need. `panels` points at the same
        // requestPanelHost the native protocol line reaches, so owner routing,
        // the timeout and invoke's fail-closed behaviour are shared rather than
        // reimplemented.
        toolContextOverrides: (sessionId) =>
          externalRuntimeToolContextForSession(
            externalBridge,
            sessionId,
            interactiveBrowserBridgeForSession(sessionId),
            externalRuntimeWorkspaceForSession(sessionId),
          ),
        backgroundWork: createExternalRuntimeBackgroundWork(),
        userTurnStarted: (sessionId) => {
          beginBrowserRunForSession(sessionId);
          deps.continued(sessionId);
        },
        mimiTools: () => externalRuntimeMimiHost(deps.notices(), externalBridge),
      },
    };
  });
}
