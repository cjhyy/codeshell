import type { BrowserWindow, IpcMain } from "electron";
import type { AgentBridge } from "./agent-bridge.js";
import type { ExternalRuntimeService } from "./external-runtime-service.js";
import { registerActivityHistoryIpc } from "./activity-history-ipc.js";
import { mobileSessionCommandAuthority } from "./mobile-remote/output-recovery-authority.js";
import {
  SessionOutputHistoryRecovery,
  type OutputHistoryRecoveryAuthorization,
  type OutputHistoryRecoveryCaller,
} from "./session-output-history-recovery.js";
import { registerSessionOutputHistoryIpc } from "./session-output-history-ipc.js";
import { assertDesktopSessionId } from "./session-validation.js";

type TrustedWindow = Pick<BrowserWindow, "isDestroyed" | "webContents">;
type OwnerBridge = Pick<AgentBridge, "panelOwnerWebContentsId" | "sessionPanelOwnerRevision">;
interface DesktopAuthorityDeps {
  windows: () => Iterable<TrustedWindow>;
  bridge: () => OwnerBridge | null;
  /** Synthetic-test seam; production uses physical Session and mounted-workspace evidence. */
  workspace?: typeof mobileSessionCommandAuthority;
}

/** Read an inactive local Session without claiming or changing its existing owner. */
export function createDesktopOutputRecoveryAuthorizer(deps: DesktopAuthorityDeps) {
  return async (
    sessionId: string,
    caller: Extract<OutputHistoryRecoveryCaller, { kind: "desktop" }>,
  ): Promise<OutputHistoryRecoveryAuthorization> => {
    assertDesktopSessionId(sessionId);
    const window = [...deps.windows()].find(
      (candidate) => candidate.webContents.id === caller.webContentsId,
    );
    const frame = window?.webContents.mainFrame;
    const bridge = deps.bridge();
    const owner = bridge?.panelOwnerWebContentsId(sessionId);
    const ownerRevision = bridge?.sessionPanelOwnerRevision(sessionId);
    const assertOwner = () => {
      if (
        !window ||
        ![...deps.windows()].includes(window) ||
        window.isDestroyed() ||
        window.webContents.isDestroyed() ||
        !frame ||
        window.webContents.mainFrame !== frame ||
        deps.bridge() !== bridge ||
        bridge?.panelOwnerWebContentsId(sessionId) !== owner ||
        bridge?.sessionPanelOwnerRevision(sessionId) !== ownerRevision ||
        (owner !== undefined && owner !== caller.webContentsId)
      )
        throw new Error("Output history recovery window or Session owner changed");
    };
    assertOwner();
    const workspace = await (deps.workspace ?? mobileSessionCommandAuthority)(sessionId);
    const assertCurrent = () => {
      assertOwner();
      workspace.assertCurrent();
    };
    assertCurrent();
    return {
      // Internal quiescing may retire runtime allocations. Those revisions are
      // deliberately absent: this key binds only caller, owner and physical workspace.
      key: JSON.stringify(["desktop", caller.webContentsId, owner, ownerRevision, workspace.stamp]),
      ownerWebContentsId: owner,
      projectId: workspace.projectId,
      assertCurrent,
    };
  };
}

interface MobileRecoveryHost {
  setOutputHistoryRecoveryService(service: SessionOutputHistoryRecovery): void;
  authorizeOutputHistoryRecovery(
    sessionId: string,
    caller: Extract<OutputHistoryRecoveryCaller, { kind: "mobile" }>,
  ): Promise<OutputHistoryRecoveryAuthorization>;
  retireOutputHistorySession(sessionId: string): void;
}

/** Keep history IPC and the shared recovery service composition out of index.ts. */
export function registerDesktopOutputHistoryHost(deps: {
  ipcMain: Pick<IpcMain, "handle" | "removeHandler">;
  windows: () => BrowserWindow[];
  historyWindows: () => BrowserWindow[];
  bridge: () => AgentBridge | null;
  external: () => ExternalRuntimeService | null;
  mobile: MobileRecoveryHost;
}): SessionOutputHistoryRecovery {
  const desktop = createDesktopOutputRecoveryAuthorizer(deps);
  const service = new SessionOutputHistoryRecovery({
    bridge: deps.bridge,
    external: deps.external,
    authorize: (sessionId, caller) =>
      caller.kind === "desktop"
        ? desktop(sessionId, caller)
        : deps.mobile.authorizeOutputHistoryRecovery(sessionId, caller),
    retire: (sessionId) => deps.mobile.retireOutputHistorySession(sessionId),
  });
  deps.mobile.setOutputHistoryRecoveryService(service);
  registerActivityHistoryIpc(deps.ipcMain, deps.historyWindows);
  registerSessionOutputHistoryIpc(deps.ipcMain, deps.windows, service);
  return service;
}
