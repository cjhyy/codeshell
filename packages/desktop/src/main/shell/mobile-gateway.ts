import { app, BrowserWindow, ipcMain, safeStorage, shell } from "electron";
import { resolve } from "node:path";
import {
  AccessPasscode,
  CloudflaredBinary,
  MobileUploadService,
  RemoteHostManager,
  TrustedDeviceStore,
  TunnelManager,
} from "@cjhyy/code-shell-server/mobile-remote";
import { accountRelayRecoveryPage } from "@cjhyy/code-shell-web/account-relay-bootstrap";
import { nativePendingApprovals } from "../../shared/pending-approvals.js";
import { createDesktopRemoteServices } from "../desktop-remote-services.js";
import { createDesktopWebService, deploymentRemoteLink } from "../desktop-web-service.js";
import type { PrepareAccountGitHubLink } from "../account-github-link.js";
import { requireLinkAccountAccess } from "../link-account-access.js";
import { getProjectStore } from "../project-store.js";
import { resolveDesktopPanelProjectPath } from "../panel-project-scope.js";
import {
  openCloudWorkbench,
  openManagedCloudWorkbench,
  closeManagedCloudWorkbench,
} from "../cloud-workbench-window.js";
import {
  MobileRemoteOrchestrator,
  type AuthenticatedMobileClientEvent,
  type MobileRemoteOrchestratorDeps,
} from "../mobile-remote-orchestrator.js";
import { bindNativeRooms } from "../mobile-remote/native-rooms.js";
import { resolveMobileStaticRoot } from "../mobile-remote/mobile-static-root.js";
import { startMobileExternalRuntime } from "../mobile-remote/start-external-runtime.js";
import { NativeRemoteTerminals } from "../mobile-remote/native-terminals.js";
import { RemoteTerminalPolicy } from "../mobile-remote/remote-terminal-policy.js";
import { registerRoomsIpc } from "../rooms-ipc.js";
import { registerMobileRemoteIpc } from "../mobile-remote-ipc.js";
import { dlog } from "../desktop-logger.js";
import type { GatewayControlEventInput } from "../im-gateway-control-server.js";
import type { PanelAppBridge } from "../panel-app-bridge.js";
import type { createDesktopHost } from "../desktop-host/main.js";

type WebService = Parameters<typeof createDesktopWebService>[0];
type MobileShellOptions = Required<
  Pick<
    MobileRemoteOrchestratorDeps,
    | "getBridge"
    | "getExternalRuntimeService"
    | "getExternalRuntimeModels"
    | "getExternalRuntimeApprovals"
    | "listDiskSessions"
  >
> & {
  host: Pick<
    ReturnType<typeof createDesktopHost>,
    "remote" | "im" | "callBusiness" | "documentSignal" | "setRemoteTerminals"
  >;
  mainDirectory: string;
  mainWindows: Set<BrowserWindow>;
  panel: Pick<PanelAppBridge, "sharedToolJobs" | "authorizePanelDirectory">;
  automations: WebService["automations"];
  resolveProjectScope: WebService["resolveProjectScope"];
  onPanelsChanged: NonNullable<WebService["onPanelsChanged"]>;
  prepareGitHubLink: PrepareAccountGitHubLink;
};

/** Native custody of paired sockets, user-approved tunnel processes and OS account effects.
 * The utility owns room execution, PTYs, grants and remote controller decisions. */
export function createMobileGatewayShell(options: MobileShellOptions) {
  const { host: desktopHost, mainWindows, getBridge } = options;
  const data = app.getPath("userData");
  const broadcastToWindows = (channel: string, payload: unknown) => {
    for (const window of BrowserWindow.getAllWindows())
      if (!window.isDestroyed()) window.webContents.send(channel, payload);
  };
  const mobileDevices = new TrustedDeviceStore(resolve(data, "mobile-remote", "devices.json"));
  const mobileUploads = new MobileUploadService({
    rootDir: resolve(data, "mobile-remote", "uploads"),
  });
  const mobileRemote = new RemoteHostManager({
    accountRelayRecoveryPage,
    nativeModelSelection: true,
    ccRoomModelSelection: true,
    outputJournal: true,
    legacyBasePages: true,
    outputJournalPageFrames: 2048,
    historyView: true,
    devices: mobileDevices,
    uploads: mobileUploads,
    webApi: createDesktopWebService({
      devices: mobileDevices,
      automations: options.automations,
      sharedToolJobs: options.panel.sharedToolJobs(),
      resolveProjectScope: options.resolveProjectScope,
      resolvePanelProjectPath: (cwd) => resolveDesktopPanelProjectPath(getProjectStore(), cwd),
      authorizePanelDirectory: (app, projectPath, workspacePath) =>
        options.panel.authorizePanelDirectory(app, projectPath, workspacePath),
      getBridge,
      captureRemoteAuthority: () => requireLinkAccountAccess(captureLinkAccount),
      remoteLink: () => deploymentRemoteLink(() => requireLinkAccountAccess(captureLinkAccount)),
      onPanelsChanged: options.onPanelsChanged,
      resolveWorkspace: (input, deviceId) =>
        mobileOrchestrator.resolveWebWorkspace(input, deviceId),
      relayStatus: () => mobileRemoteController.relayStatus(),
      phoneFeature: () => accountFeatures.snapshot()["relay.phone"],
      onSessionsChanged: (cwd, sessionId) => {
        const line = JSON.stringify({
          jsonrpc: "2.0",
          method: "serve/sessionsChanged",
          params: { cwd, sessionId },
        });
        mobileRemote.broadcastRaw(line);
        broadcastToWindows("agent:msg", line);
      },
    }),
    // The mobile SPA resides beside the Desktop main bundle (unpacked in the packaged app).
    mobileRootDir: resolveMobileStaticRoot(options.mainDirectory),
    onClientEvent: async (event) => {
      // The remote host tags authenticated events with both the device id and a
      // per-socket viewer id. Device state/replies remain shared per phone, while
      // transcript ownership follows the exact tab that subscribed.
      await mobileOrchestrator.handleMobileClientEvent(event as AuthenticatedMobileClientEvent);
    },
  });
  const pendingMobileApprovals = nativePendingApprovals(desktopHost.callBusiness);

  // Settings starts the public tunnel explicitly through mobileRemote:start.
  const cloudflaredBinary = new CloudflaredBinary({
    baseDir: resolve(data, "mobile-remote"),
  });
  const tunnelManager = new TunnelManager({
    binaryPath: () => cloudflaredBinary.binaryPath(),
  });
  const accessPasscode = new AccessPasscode({
    filePath: resolve(data, "mobile-remote", "access.json"),
  });
  const { mobileRemoteController, cloudManagementManager, captureLinkAccount, accountFeatures } =
    createDesktopRemoteServices({
      remote: desktopHost.remote,
      documentSignal: desktopHost.documentSignal,
      app,
      ipcMain,
      userDataDir: data,
      listProjects: async () =>
        (await getProjectStore().list()).flatMap((project) => {
          const root = project.roots.find((entry) => entry.id === project.primaryRootId);
          return root ? [{ id: project.id, name: project.name, path: root.path }] : [];
        }),
      safeStorage,
      windows: () => mainWindows,
      openExternal: (url) => shell.openExternal(url),
      prepareGitHubLink: options.prepareGitHubLink,
      host: mobileRemote,
      tunnel: tunnelManager,
      binary: cloudflaredBinary,
      passcode: accessPasscode,
      cloudWindows: { open: openManagedCloudWorkbench, close: closeManagedCloudWorkbench },
      openLegacyCloud: openCloudWorkbench,
    });
  function publishGatewayControlEventBestEffort(event: GatewayControlEventInput): void {
    void desktopHost.im.publish(event).catch((error) =>
      dlog("main", "im_gateway.notification_publish.failed", {
        type: event.type,
        error: String(error),
      }),
    );
  }
  // Forward tunnel status changes to every renderer so the UI can reflect
  // connected / disconnected (address invalidated) without polling.
  tunnelManager.on("status", (status: string, detail?: unknown) => {
    if (status === "connected" && typeof detail === "string") {
      mobileRemote.setPublicBaseUrl(detail);
    }
    broadcastToWindows("mobileRemote:tunnelStatus", { status, detail });
    if (status === "connected" && typeof detail === "string") {
      publishGatewayControlEventBestEffort({
        type: "tunnel.connected",
        title: "CodeShell 公网隧道已连接",
        text: `公网地址：${detail}`,
        button: { text: "打开 CodeShell", url: detail },
      });
    } else if (status === "disconnected") {
      publishGatewayControlEventBestEffort({
        type: "tunnel.disconnected",
        title: "CodeShell 公网隧道已断开",
        text: "公网隧道连接已断开，请在桌面端或聊天命令中重新开启。",
      });
    } else if (status === "error") {
      publishGatewayControlEventBestEffort({
        type: "tunnel.error",
        title: "CodeShell 公网隧道异常",
        text: typeof detail === "string" ? detail : "公网隧道发生异常。",
      });
    }
  });
  // Push the live online-device set to every renderer whenever a phone connects
  // or disconnects, so the trusted-device list can show per-device online lamps.
  mobileRemote.on("online-change", (ids: string[]) => {
    getBridge()?.setMobileOutputOnline(ids.length > 0);
    broadcastToWindows("mobileRemote:onlineChange", ids);
  });

  const { hostedRooms, roomHistory } = bindNativeRooms(
    desktopHost,
    mobileRemote,
    mobileUploads,
    mainWindows,
    getBridge,
    (device) => mobileOrchestrator.sendProjectList(device),
  );
  const remoteTerminals = new NativeRemoteTerminals({
    remote: mobileRemote,
    policy: new RemoteTerminalPolicy(resolve(data, "mobile-remote", "terminal.json")),
  });
  desktopHost.setRemoteTerminals(remoteTerminals);
  const mobileOrchestrator: MobileRemoteOrchestrator = new MobileRemoteOrchestrator({
    readColdGoal: (sessionId) => desktopHost.callBusiness("goals/read", {sessionId}),
    readCcRoom: desktopHost.callBusiness,
    roomHistory,
    listDiskSessions: options.listDiskSessions,
    remote: mobileRemote,
    terminals: remoteTerminals,
    uploads: mobileUploads,
    pendingApprovals: pendingMobileApprovals,
    hostedRooms,
    getBridge,
    getExternalRuntimeService: options.getExternalRuntimeService,
    getExternalRuntimeModels: options.getExternalRuntimeModels,
    getExternalRuntimeApprovals: options.getExternalRuntimeApprovals,
    startMobileRuntime: (request) =>
      startMobileExternalRuntime(
        {
          service: options.getExternalRuntimeService,
          bridge: getBridge,
          windows: () => mainWindows,
        },
        request,
      ),
    broadcastToWindows,
  });

  mobileRemote.on("online-change", () => hostedRooms.presence());
  mobileRemote.on("viewer-offline", ({ viewerId }) => mobileOrchestrator.releaseViewer(viewerId));

  return {
    mobileRemote,
    mobileOrchestrator,
    pendingMobileApprovals,
    captureLinkAccount,
    registerIpc() {
      registerRoomsIpc({
        readCcRoom: desktopHost.callBusiness,
        roomHistory,
        mainWindows,
        hostedRooms,
        mobileOrchestrator,
      });
      return registerMobileRemoteIpc({
        approvalCaller(event, sessionId) {
          const signal = desktopHost.documentSignal(event);
          if (getBridge()?.panelOwnerWebContentsId(sessionId) !== event.sender.id)
            throw Error("Approval session belongs to another document");
          return { owner: event.sender.id, signal };
        },
        mobileDevices,
        mobileRemote,
        cloudflaredBinary,
        tunnelManager,
        accessPasscode,
        mobileRemoteController,
        mobileOrchestrator,
        remoteTerminals,
      });
    },
    async stop() {
      await Promise.allSettled([
        mobileRemoteController.dispose(),
        cloudManagementManager.dispose(),
      ]);
    },
    disposeUploads: () => mobileUploads.dispose(),
  };
}
