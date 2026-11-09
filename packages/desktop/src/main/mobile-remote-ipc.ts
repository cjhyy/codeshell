import type { MobileRemoteController } from "./mobile-remote-controller.js";
import { ipcMain } from "electron";
import {
  AccessPasscode,
  CloudflaredBinary,
  RemoteHostManager,
  TrustedDeviceStore,
  TunnelManager,
} from "@cjhyy/code-shell-server/mobile-remote";
import { MobileRemoteOrchestrator } from "./mobile-remote-orchestrator.js";

export interface MobileRemoteIpcDeps {
  mobileDevices: TrustedDeviceStore;
  mobileRemote: RemoteHostManager;
  cloudflaredBinary: CloudflaredBinary;
  tunnelManager: TunnelManager;
  accessPasscode: AccessPasscode;
  mobileRemoteController: MobileRemoteController;
  mobileOrchestrator: MobileRemoteOrchestrator;
}

/** Mobile Web Remote device, tunnel, passcode and approval-relay routes. */
export function registerMobileRemoteIpc(deps: MobileRemoteIpcDeps) {
  const {
    mobileDevices,
    mobileRemote,
    cloudflaredBinary,
    tunnelManager,
    accessPasscode,
    mobileRemoteController,
    mobileOrchestrator,
  } = deps;
  // ── Mobile Web Remote ───────────────────────────────────────────────────────
  const startMobileRemote = (opts?: { mode?: "lan" | "tunnel" | "relay" }) =>
    mobileRemoteController.start(opts);
  const stopMobileRemote = () => mobileRemoteController.stop();
  const createMobileRemotePairingUrl = () => mobileRemoteController.pairingUrl();
  const getMobileRemoteGatewayStatus = () => mobileRemoteController.status();

  ipcMain.handle("mobileRemote:listDevices", async () => mobileDevices.listDevices());
  ipcMain.handle("mobileRemote:revokeDevice", async (_e, id: string) => {
    mobileDevices.revoke(id);
    mobileRemote.revokeDevice(id);
  });
  ipcMain.handle("mobileRemote:removeDevice", async (_e, id: string) => {
    mobileDevices.remove(id);
    mobileRemote.revokeDevice(id);
  });
  ipcMain.handle("mobileRemote:renameDevice", async (_e, id: string, name: string) =>
    mobileDevices.rename(id, name),
  );
  ipcMain.handle("mobileRemote:onlineDevices", async () => mobileRemote.onlineDeviceIds());
  // ── Tunnel-specific IPC ─────────────────────────────────────────────────────
  ipcMain.handle("mobileRemote:cloudflaredInstalled", async () => cloudflaredBinary.isInstalled());
  ipcMain.handle("mobileRemote:downloadCloudflared", async (e) => {
    const sender = e.sender;
    await cloudflaredBinary.ensureBinary((pct) => {
      if (!sender.isDestroyed()) sender.send("mobileRemote:downloadProgress", pct);
    });
    return true;
  });
  ipcMain.handle("mobileRemote:passcodeStatus", async () => ({
    isSet: accessPasscode.isSet(),
  }));
  ipcMain.handle("mobileRemote:setPasscode", async (_e, passcode: string) => {
    if (typeof passcode !== "string" || passcode.length < 4 || passcode.length > 256) {
      throw new Error("访问口令需要 4 到 256 个字符");
    }
    accessPasscode.set(passcode);
    return true;
  });
  ipcMain.handle("mobileRemote:tunnelStatus", async () => ({
    running: tunnelManager.isRunning(),
    connected: tunnelManager.isConnected(),
  }));
  ipcMain.handle("mobileRemote:updatePermissionModes", async (_e, entries: unknown) => {
    mobileOrchestrator.updatePermissionModes(entries);
    return true;
  });
  ipcMain.handle(
    "mobileRemote:approvalResolved",
    async (
      _e,
      input: {
        requestId?: unknown;
        sessionId?: unknown;
        connectionId?: unknown;
        generation?: unknown;
        approved?: unknown;
        answer?: unknown;
      },
    ) => {
      const requestId = typeof input?.requestId === "string" ? input.requestId : "";
      if (!requestId) return false;
      mobileOrchestrator.broadcastApprovalResolved({
        requestId,
        sessionId: typeof input?.sessionId === "string" ? input.sessionId : undefined,
        connectionId: typeof input?.connectionId === "string" ? input.connectionId : undefined,
        generation: typeof input?.generation === "number" ? input.generation : undefined,
        approved: typeof input?.approved === "boolean" ? input.approved : undefined,
        answer: typeof input?.answer === "string" ? input.answer : undefined,
      });
      return true;
    },
  );
  return {
    startMobileRemote,
    stopMobileRemote,
    createMobileRemotePairingUrl,
    getMobileRemoteGatewayStatus,
  };
}
