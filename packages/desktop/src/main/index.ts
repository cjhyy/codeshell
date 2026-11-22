import { createMimiRuntimeShell } from "./shell/mimi-runtime.js";
import { dispatchGatewayPetChat } from "./shell/mimi-gateway.js";
import { trustedMimiWindows } from "./shell/mimi-windows.js";
import { assertQuickChatClaim,registerSessionLifecycle } from "./shell/session-lifecycle.js";
import { createDesktopTaskInbox } from "./shell/task-inbox.js";
import { createMimiPresenceShell } from "./shell/mimi-presence.js";
import { createPanelCookieAdapter,registerPanelWindowShell } from "./shell/panel-app.js";
import { registerPluginLibraryIpc } from "./plugin-library-ipc.js";
import { registerHostedWechatLogin } from "./desktop-host/wechat-login-client.js";
import { registerConfigurationSettingsIpc } from "./configuration-settings-ipc.js";
import type { SettingsChange } from "../shared/settings-change.js";
import {
	setDesktopCredentialFiles,
} from "./credential-file-client.js";
import { taskInboxEnabled } from "./task-inbox/task-host-reads.js";
import { registerLinkedFileSourceIpc } from "./linked-file-sources-ipc.js";
import { openLinkedFileSourceOperation } from "./linked-file-sources-host.js";
import { registerOperationBatchHost } from "./operation-batch-host.js";
import { createMobileGatewayShell } from "./shell/mobile-gateway.js";
import { createDesktopHost } from "./desktop-host/main.js";
import { createDesktopModuleRegistry } from "./desktop-shutdown.js";
import { registerProjectPanelIpc } from "./project-panel-ipc.js";
import { registerProfileSwitchIpc,hostedProfileSwitch } from "./profile-switch-ipc.js";
import { registerSourceCollectionIpc } from "./source-collections-ipc.js";
import { openSourceCollectionOperation } from "./source-collections-host.js";
import { registerRemoteLinkIpc } from "./remote-link-ipc.js";
import { linkAccountExecutionOptions } from "./link-account-access.js";
import { registerOperationResolutionHost } from "./operation-resolution-host.js";
/**
 * Electron Main owns windows, native authority and the Desktop Host lifecycle.
 */

import {
	app,
	BrowserWindow,
	dialog,
	ipcMain,
	shell,
	safeStorage,
	powerMonitor,
} from "electron";
import { registerWindowTitleBarIpc } from "./window-titlebar.js";
import { registerCloudEnvironmentIpc } from "./cloud-environment-ipc.js";
import { registerNativeShutdown } from "./shell/shutdown.js";
import { registerNativeStartup } from "./shell/startup.js";
import { createDesktopManagedRuntimeWiring } from "./managed-runtime-wiring.js";
import { fileURLToPath,pathToFileURL } from "node:url";
import { AppRendererNavigation } from "./app-renderer-navigation.js";
import { dirname,resolve,isAbsolute,join } from "node:path";
import {
	SettingsManager,userHome,
	codeShellHome,
	setDefaultCredentialAccess,
	localCredentialAccess,
	sessionsRoot,
	previewLocalTheme,
	installReviewedLocalTheme,
	listInstalledThemes,
	uninstallTheme,
	type ThemePreview
} from "@cjhyy/code-shell-core";
import {
	agentNotificationBus,
	getMergedCatalog,
	isGitAvailable,
	resolveGitPath,
	describeTranscribe,
} from "@cjhyy/code-shell-core/internal";
import { AgentBridge,resolveNoRepoCwd } from "./agent-bridge.js";
import { createNativeExternalRuntime } from "./shell/external-runtime.js";
import { nativeExternalGoals } from "./shell/external-goals.js";
import { buildExternalRuntimeHandoffFromEvents } from "./external-runtime-handoff.js";
import {
	requireRendererProjectPath,
} from "./renderer-project-path.js";
import { NativeMimiScheduler } from "./desktop-host/mimi-scheduler-client.js";
import { isPetRuleScheduleJob } from "./pet/pet-rule-schedule.js";
import {
	sessionRouteHandler
} from "./pet/session-bridge-wiring.js";
import { installedThemeToPack } from "./theme-pack-conversion.js";
import { themeImportDialogOptions } from "./theme-import-dialog.js";
import { SafeStorageCipher } from "./credential-cipher.js";
import { createDesktopModelRequestSigner } from "./model-request-signing-service.js";
import { McpOAuthService,type McpOAuthLoginInput } from "./mcp-oauth-service.js";
import { LinkDeviceOAuthBroker } from "./link-device-oauth.js";
import { type ManagedCliInstallResult } from "./link-cli-installer.js";
import { inspectReadableReplyAttachment } from "./image-read-service.js";
import { NativeMediaProtocol } from "./hosted-media-protocol.js";
import {
	browserRuntime
} from "./browser-runtime/index.js";
import type { AutomationSessionMeta } from "./automation-host.js";
import { createAutomationResumeTurn } from "./automation-resume-turn.js";
import { automationLifecycleNotification } from "./automation-notification.js";
import { DesktopNotifier } from "./desktop-notifier.js";
import { findNotificationWindow } from "./native-desktop-notification.js";
import { registerNotificationFallback,showSystemNotification } from "./system-notification.js";
import * as desktopNotifications from "./desktop-notification-routes.js";
import type { CreateAutomationInput } from "./automation-service.js";
import { dlog } from "./desktop-logger.js";
import {
	type GatewayControlEventAttachment,
	type GatewayControlEventInput
} from "./im-gateway-control-server.js";
import { registerImGatewayIpc } from "./im-gateway-ipc.js";
import { QuickChatOwnershipRegistry } from "./quick-chat-ownership.js";
import { revealInFinder,openPath } from "./desktop-services.js";
import { registerDesktopOutputHistoryHost } from "./session-output-history-host.js";
import { registerSessionCatalogIpc } from "./session-catalog-ipc.js";
import { hostCatalogClient } from "./desktop-host/catalog-client.js";
import * as backgroundWork from "./cc-room/background-work-ipc.js";
import { registerOptimizationLabHost } from "./optimization-lab-host.js";
import { assertDesktopSessionId } from "./session-validation.js";
import { getSessionEvents } from "./rawTranscript.js";
import { invalidatePanelAppBindingGuard,isPanelAppBoundToProject } from "./panel-apps-service.js";
import { PanelAppBridge } from "./panel-app-bridge.js";
import { buildPanelAgentTaskModelCatalog } from "./panel-app-agent-task-models.js";
import {
	gitDownloadUrl,
	gitInstallGuidance,
} from "./marketplace-service.js";
import { registerSourceCatalogIpc } from "./source-catalog-ipc.js";
import {
	checkForUpdate,
	downloadUpdate,
	quitAndInstall,
	getLastStatus,
} from "./updater.js";
import { getProjectStore } from "./project-store.js";
import {
	createDesktopPanelProjectScopeResolver,
	isRegisteredPanelProjectRoot,
} from "./panel-project-scope.js";
import { registerProjectAuthorityIpc } from "./project-authority-ipc.js";
import { bindWorkbenchInstance,createWorkbenchSurface,prepareNativeInstance } from "./shell/workbench-window.js";
import { getTrust,getTrustCachedSync } from "./trust-store.js";
import { installAppMenu } from "./menu.js";
import { applyGitPathFromSettings } from "./git-path-settings.js";
import { invalidateMcpProbeCache } from "./mcp-probe-service.js";
import {
	resolveRendererConfigurationTarget,
	type RendererConfigurationTarget,
} from "./renderer-configuration-authority.js";
import { registerProfileCatalogIpc } from "./profile-catalog-ipc.js";
import { registerLinkCredentialIpc } from "./link-credentials-ipc.js";
import { registerBrowserSessionIpc } from "./browser-session-ipc.js";
import {
	registerSpeechIpc,
	transcribeConfiguredAudio,
	ensureDesktopMicrophoneAccess,
} from "./speech-ipc.js";
import { registerAttachmentsIpc } from "./attachments-ipc.js";
import { registerAgentsMediaIpc } from "./agents-media-ipc.js";
import { registerSkillsMcpIpc } from "./skills-mcp-ipc.js";
import { registerModelCatalogIpc } from "./model-catalog-ipc.js";
import { registerDialogPickerIpc } from "./dialog-picker-ipc.js";
import { registerExternalRuntimeIpc } from "./external-runtime-ipc.js";
import { createBrowserWindowShell } from "./shell/browser-windows.js";
import { registerGitReviewIpc } from "./git-review-ipc.js";
import { registerWorkspaceFilesIpc } from "./workspace-files-ipc.js";
import { registerMemoryIpc } from "./memory-ipc.js";
import { registerAutomationIpc } from "./automation-ipc.js";
import { registerTrustNotificationIpc } from "./trust-notification-ipc.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const appRendererNavigation = new AppRendererNavigation(
  process.env.VITE_DEV_URL ||
    pathToFileURL(resolve(__dirname, "..", "renderer", "index.html")).href,
  (url) => shell.openExternal(url),
);
let seededDefaults = false;
const desktopHost = createDesktopHost(
  join(__dirname, "desktop-host.mjs"),
  appRendererNavigation,
  (): void => {
    taskInboxService.hostRestarted();
    // Retry a lost Host generation on reconnect. A successful first-run seed is
    // consumed for the life of this application so a user's later removal sticks.
    if (!seededDefaults) {
      const resourcesDir = app.isPackaged
        ? join(process.resourcesPath, "packages", "desktop", "resources")
        : join(app.getAppPath(), "resources");
      void desktopHost.callBusiness("marketplace/bootstrap", { resourcesDir })
        .then(() => { seededDefaults = true; })
        .catch((error) => dlog("main", "plugins.bootstrap.failed", { error: String(error) }));
    }
    void mimiRuntime.reconcileSources().catch((error) =>
      dlog("main", "pet.external.restart.failed", { error: String(error) }),
    );
  },
  applyRendererSettingsSideEffects,
);
setDesktopCredentialFiles(desktopHost.credentialCommand);
const { listDiskSessions, automation: cron } = desktopHost;
const mimiRuntime = createMimiRuntimeShell(desktopHost);
const chromeNativeMessaging = prepareNativeInstance();
const mainWindows = new Set<BrowserWindow>();
registerNotificationFallback(
  ipcMain,
  (id) =>
    findNotificationWindow(mainWindows, id ? bridge?.panelOwnerWebContentsId(id) : undefined)
      ?.webContents.id,
  (event) => {
    if (![...mainWindows].some((window) => window.webContents === event.sender))
      throw Error("Desktop notifications require a workbench");
    return desktopHost.documentSignal(event);
  },
);
const mediaPreviewService = new NativeMediaProtocol(
  desktopHost.callBusiness,
  (ownerId, sessionId) => {
    const sessionOwner = bridge?.panelOwnerWebContentsId(sessionId);
    return (
      (sessionOwner === undefined || sessionOwner === ownerId) &&
      [...mainWindows].some(
        (window) =>
          !window.isDestroyed() &&
          !window.webContents.isDestroyed() &&
          window.webContents.id === ownerId,
      )
    );
  },
);
/** Deliver to the one live window owning `webContentsId`; other windows never see it. */
function sendToOwnerWindow(webContentsId: number | undefined, channel: string, payload: unknown) {
  [...mainWindows]
    .find((window) => !window.isDestroyed() && window.webContents.id === webContentsId)
    ?.webContents.send(channel, payload);
}
let markPetIpcReady: (() => void) | null = null;
const petIpcReady = new Promise<void>((resolveReady) => {
  markPetIpcReady = resolveReady;
});
const mimiShell = createMimiPresenceShell({
  mainDirectory: __dirname,
  navigation: appRendererNavigation,
  mainWindows,
  petIpcReady,
  attach: (win) => bridge?.attachPetWindow(win),
  openOverview: openPetOverviewFromWidget,
  cwd: resolveNoRepoCwd,
});
const { ownsDesktopInstance, restoreMainWindow } = bindWorkbenchInstance(
  chromeNativeMessaging, mainWindows, preferredMainWindow, createWindow,
);

dlog("main", "boot", { argv: process.argv, execPath: process.execPath, cwd: process.cwd() });

/**
 * The bridge is process-global: a single agent worker subprocess
 * services every BrowserWindow we open. Per-window state lives in
 * the renderer (transcripts, view, selection); the bridge just
 * pipes stdio. Multi-window therefore means "extra views into the
 * same worker" — not "extra concurrent agents".
 */
let bridge: AgentBridge | null = null;
let desktopNotifier: DesktopNotifier | null = null;
const externalRuntime = createNativeExternalRuntime({
  host: desktopHost,
  bridge: () => bridge!,
  windows: mainWindows,
  onApproval: (event) => mobileOrchestrator.mirrorExternalApproval(event),
  changed(sessionId, active, ownerId) {
    sendToOwnerWindow(ownerId, "externalRuntime:sessionState", { sessionId, active });
    markSessionTaskDirty(sessionId);
  },
  continued: (id) => userContinuedTask(id),
  notices: () => mimiRuntime.notices,
});
const desktopModules = createDesktopModuleRegistry([externalRuntime]);
const resolvePanelProjectScope = createDesktopPanelProjectScopeResolver({
  store: getProjectStore(),
});
const desktopManagedRuntimes = createDesktopManagedRuntimeWiring(app, process.resourcesPath);
const panelAppBridge = new PanelAppBridge({
  isTrustedHost: (sender) =>
    [...mainWindows].some((window) => !window.isDestroyed() && window.webContents === sender),
  isWorkspaceTrusted: (cwd) => getTrustCachedSync(cwd) === "trusted",
  isPanelAppBound: isPanelAppBoundToProject,
  isProjectRoot: (projectPath, rootPath) =>
    isRegisteredPanelProjectRoot(getProjectStore(), projectPath, rootPath),
  resolveProjectScope: resolvePanelProjectScope,
  resolveBackgroundServiceNode: desktopManagedRuntimes.resolveBackgroundServiceNode,
  getAgentBridge: () => bridge,
  getExternalRuntimeService: () => externalRuntime.service,
  externalRuntimeInitialContext: async (sessionId) =>
    buildExternalRuntimeHandoffFromEvents(await getSessionEvents(sessionId)),
  agentTaskModels: (cwd) =>
    buildPanelAgentTaskModelCatalog(
      new SettingsManager(cwd, "full", getTrustCachedSync(cwd) === "trusted").get(),
      getMergedCatalog(),
    ),
  showNotification: showSystemNotification,
  cookieCredentials: createPanelCookieAdapter((cwd) => bridge?.pushCredentialSnapshot(cwd)),
  automations: {
    uniqueCreation: true,
    conditional: cron.panel,
    list: (scope) => cron.call("forSession", scope.resumeSessionId),
    create: (input, scope) =>
      cron.call("create", { ...input, resumeSessionId: scope.resumeSessionId }),
    update: (id, patch, scope) => cron.call("update", { id, patch, scope }),
    pause: (id) => cron.call("pause", id),
    resume: (id) => cron.call("resume", id),
    delete: (id) => cron.call("delete", id),
    runNow: (id) => cron.call("runNow", id),
  },
  audioTranscription: {
    status: (cwd) => {
      const description = describeTranscribe(cwd);
      return {
        available: description.source !== "none",
        source: description.source,
        ...(description.model ? { model: description.model } : {}),
      };
    },
    requestMicrophoneAccess: () => ensureDesktopMicrophoneAccess(),
    transcribe: (input) => transcribeConfiguredAudio(input),
  },
});
panelAppBridge.registerIpc();
const browserWindows = createBrowserWindowShell({
  mainWindows, panelAppBridge, appRendererNavigation, mainDirectory: __dirname,
});
registerPanelWindowShell(panelAppBridge, mainWindows, __dirname);
const imGatewayService = desktopHost.im;
registerImGatewayIpc(ipcMain, imGatewayService, (event, work) =>
  desktopHost.withDocumentCaller(event, () =>
    imGatewayService.withDocument(desktopHost.documentSignal(event), work),
  ),
);
registerHostedWechatLogin(ipcMain, desktopHost, (work) => imGatewayService.withWechatLogin(work));
const nativeMimiScheduler = new NativeMimiScheduler(
  desktopHost.callBusiness,
  powerMonitor,
  (error) => dlog("main", "pet.followUp.scheduler.failed", { error: String(error) }),
);
const taskInboxDisposers: Array<() => void> = [];
const taskInboxAutomationSessions = new Map<string, string>();
let mcpOAuthService: McpOAuthService | null = null;
const linkDeviceOAuthBroker = new LinkDeviceOAuthBroker();
const managedCliInstallJobs = new Map<string, Promise<ManagedCliInstallResult>>();


const quickChatOwnership = new QuickChatOwnershipRegistry();

function getMcpOAuthService(): McpOAuthService {
  if (!mcpOAuthService) {
    mcpOAuthService = new McpOAuthService({
      openExternal: (url) => shell.openExternal(url),
      onCredentialsChanged: () => {
        bridge?.pushCredentialSnapshot(undefined);
        invalidateMcpProbeCache();
        bridge?.notifyWebConfigurationChanged();
      },
    });
  }
  return mcpOAuthService;
}

function normalizeMcpOAuthLoginInput(raw: unknown): McpOAuthLoginInput {
  if (!raw || typeof raw !== "object") throw new Error("mcpOAuth:login requires an input");
  const input = raw as Record<string, unknown>;
  const optionalString = (value: unknown): string | undefined =>
    typeof value === "string" && value.trim() ? value.trim() : undefined;
  if (input.source === "catalog") {
    const profileId = optionalString(input.profileId);
    if (!profileId) throw new Error("mcpOAuth:login requires profileId");
    if (profileId === "figma-mcp") throw new Error("请通过 Figma Link 连接官方 MCP。");
    return { source: "catalog", profileId, credentialId: optionalString(input.credentialId) };
  }
  if (input.source !== "mcp") throw new Error("mcpOAuth:login source must be catalog or mcp");
  const serverName = optionalString(input.serverName);
  const serverUrl = optionalString(input.serverUrl);
  if (!serverName || !serverUrl)
    throw new Error("mcpOAuth:login requires serverName and serverUrl");
  return {
    source: "mcp",
    serverName,
    serverUrl,
    credentialId: optionalString(input.credentialId),
    clientId: optionalString(input.clientId),
    authorizationEndpoint: optionalString(input.authorizationEndpoint),
    tokenEndpoint: optionalString(input.tokenEndpoint),
    scopes: Array.isArray(input.scopes)
      ? input.scopes.filter((scope): scope is string => typeof scope === "string")
      : undefined,
  };
}

function broadcastPluginCommandsChanged(windows: Iterable<BrowserWindow>): void {
  for (const window of windows) {
    if (!window.isDestroyed()) window.webContents.send("plugin-commands:changed");
  }
}

function broadcastPanelAppsChanged(windows: Iterable<BrowserWindow>): void {
  // Invalidate before notifying native and paired Web clients of Panel changes.
  invalidatePanelAppBindingGuard();
  bridge?.notifyWebConfigurationChanged();
  for (const window of windows) {
    if (window.isDestroyed()) continue;
    window.webContents.send("panel-apps:changed");
  }
}

desktopHost.onPluginJobsChanged((jobs) => {
  const installed = jobs.some((job) => job.status === "installed");
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send("plugins:installJobsChanged", jobs);
  }
  if (installed) broadcastPluginCommandsChanged(BrowserWindow.getAllWindows());
});

let prepareAccountGitHubLink:
  | ReturnType<typeof registerRemoteLinkIpc>["prepareGitHubLink"]
  | undefined = undefined;
const mobileShell = createMobileGatewayShell({
  host: desktopHost,
  mainDirectory: __dirname,
  mainWindows,
  panel: panelAppBridge,
  automations: cron.panel,
  resolveProjectScope: resolvePanelProjectScope,
  onPanelsChanged(id, kind) {
    if (kind === "remove") panelAppBridge.revokeAppId(id);
    broadcastPanelAppsChanged(BrowserWindow.getAllWindows());
  },
  getBridge: () => bridge,
  getExternalRuntimeService: () => externalRuntime.service,
  getExternalRuntimeApprovals: () => externalRuntime.approvals,
  getExternalRuntimeModels: () => externalRuntimeModelService.list(),
  listDiskSessions,
  prepareGitHubLink(signal, authorized) {
    if (!prepareAccountGitHubLink) throw new Error("GitHub Link 服务尚未就绪。");
    return prepareAccountGitHubLink(signal, authorized);
  },
});
const { mobileRemote, mobileOrchestrator, pendingMobileApprovals, captureLinkAccount } = mobileShell;
// Main-owned external runtimes use the same account gate as the stdio worker.
setDefaultCredentialAccess({
  ...localCredentialAccess,
  executeRemoteLinkAction: async (input, options) =>
    localCredentialAccess.executeRemoteLinkAction!(
      input,
      linkAccountExecutionOptions(captureLinkAccount, options),
    ),
});

function publishGatewayControlEvent(event: GatewayControlEventInput): Promise<void> {
  return imGatewayService.publish(event);
}

const projectStore = getProjectStore();
const cloudEnvironment = registerCloudEnvironmentIpc({
  ipcMain,
  windows: () => mainWindows,
  userDataDir: app.getPath("userData"),
  assertLocalProject: (id) => projectStore.requireLive(id),
});
async function createWindow(): Promise<BrowserWindow> {
  const { win, loadRenderer } = await createWorkbenchSurface(__dirname, {
    mainWindows, hardenGuests: browserWindows.hardenWebviewGuests,
    bind(contents) {
      appRendererNavigation.bind(contents);
      desktopHost.trackWorkbench(contents);
    },
    releaseDocumentAccess(id) {
      mediaPreviewService.releaseOwner(id);
      rendererBrowserSessionAccess.forgetWindow(id);
    },
    ownedSessionIds: (id) => externalRuntime.service?.ownedSessionIds(id) ?? [],
    releaseWindow(id, parentId) {
      externalRuntime.approvals?.cancelWindow(id);
      void externalRuntime.service?.stopOwnedBy(id);
      browserWindows.releaseParent(parentId);
    },
    lastNonMacWindowClosed: () => browserRuntime.closeAll(),
  });
  if (!bridge) {
    bridge = new AgentBridge(
      win,
      (req) =>
        getMcpOAuthService().resolveAccessToken(req.id, {
          serverUrl: req.serverUrl,
          forceRefresh: req.forceRefresh,
        }),
      {
        begin: ({ sessionId, ownerId, claimId }) =>
          quickChatOwnership.beginFork(sessionId, ownerId, claimId),
        settle: async ({ sessionId, ownerId, claimId, succeeded }) => {
          await quickChatOwnership.settleFork(sessionId, ownerId, claimId, succeeded, () =>
            deleteDesktopSession(sessionId),
          );
        },
        isClaimActive: ({ sessionId, ownerId, claimId }) =>
          quickChatOwnership.isClaimActive(sessionId, ownerId, claimId),
      },
      async (input) =>
        (await cron.call("create", input as unknown as CreateAutomationInput)) as unknown as Record<
          string,
          unknown
        >,
      createDesktopModelRequestSigner({
        hostDirectory: codeShellHome(),
        sessionStorageDir: sessionsRoot(),
        cipher: new SafeStorageCipher(),
        encryptionAvailable: async () =>
          (await safeStorage.isAsyncEncryptionAvailable()) &&
          (process.platform !== "linux" ||
            !["basic_text", "unknown"].includes(safeStorage.getSelectedStorageBackend())),
        hasActiveEphemeralOwner: (sessionId) => quickChatOwnership.hasActiveOwner(sessionId),
        hasActiveHostTaskOwner: (sessionId) => panelAppBridge.hasActiveAgentTaskOwner(sessionId),
      }),
      captureLinkAccount,
      (sessionId, ownerId) => rendererBrowserSessionAccess.sessionOwnerClaimed(sessionId, ownerId),
      desktopHost.setOwner,
      desktopHost.sessionsChanged,
      userContinuedTask,
      desktopHost.createWorkerBridge,
      () => cron.call("reload", undefined),
    );
    // External Agent Runtimes (Codex / Claude Code). Everything
    // security-relevant is resolved here, in the composition root: this is the
    // only layer that knows the owning window, whether the project is trusted,
    // and which feature flags are on. The layers below deliberately refuse to
    // default any of it.
    bridge.setMobileOutputOnline(mobileRemote.onlineDeviceIds().length > 0);
    observeWorkerTasks(bridge);
    const externalBridge = bridge;
    desktopModules.start();

    externalBridge.setExternalGoalRpcHandler(
      nativeExternalGoals({
        window: (id) => [...mainWindows].find((w) => !w.isDestroyed() && w.webContents.id === id),
        documentSignal: (w) =>
          desktopHost.documentSignal({ sender: w.webContents, senderFrame: w.webContents.mainFrame }),
        ownsMimiDocument: (id, sessionId) => externalBridge.ownsMimiDocument(id, sessionId),
        watchOwner: desktopHost.watchGoalOwner,
        call: desktopHost.callBusiness,
        runtime: () => externalRuntime.service,
        hasWorker: () => externalBridge.hasLiveWorker(),
        onGoalRead: (id) => void mimiRuntime.notices?.reconcileGoalNotices(id),
      }),
    );

    bridge.subscribeOwnedExternalStream((entry) => {
      mobileOrchestrator.mirrorOwnedExternalStream(entry);
    });

    // Mirror every worker→renderer line onto any connected mobile clients, so
    // the phone sees the same stream (messages, tool summaries, approvals).
    bridge.subscribeOutbound((line, snapshotEntry) => {
      if (snapshotEntry) {
        mobileRemote.broadcast({
          type: "session.stream",
          sessionId: snapshotEntry.sessionId,
          seq: snapshotEntry.seq,
          epoch: snapshotEntry.epoch,
          event: snapshotEntry.event,
        });
      } else {
        mobileRemote.broadcastRaw(line);
      }
    });
    await mimiRuntime.start(bridge, loadRenderer, {
      externalRuntime,
      imGatewayService,
      nativeMimiScheduler,
      mainWindows,
      appRendererNavigation,
      mobileOrchestrator,
      pendingMobileApprovals,
      taskInboxService,
      markSessionTaskDirty,
      startMobileRemote,
      stopMobileRemote,
      getMobileRemoteGatewayStatus,
      listAllDiskSessions,
      archiveDiskSession,
      inspectKnownReplyAttachments,
      knownReplyAttachmentCwds,
      publishGatewayControlEvent,
      revealSessionWindow,
      windows: mimiEventWindows,
      notifier: () => desktopNotifier,
    });
    markPetIpcReady?.();
    markPetIpcReady = null;
  } else {
    bridge.attachWindow(win);
    loadRenderer();
  }

  await installAppMenu(win, projectStore);
  return win;
}

function mimiEventWindows(): BrowserWindow[] {
  return trustedMimiWindows([...mainWindows, ...mimiShell.windows()], appRendererNavigation);
}

function preferredMainWindow(): BrowserWindow | null {
  const focused = BrowserWindow.getFocusedWindow();
  if (focused && mainWindows.has(focused) && !focused.isDestroyed()) return focused;
  return Array.from(mainWindows).find((win) => !win.isDestroyed()) ?? null;
}

async function openPetOverviewFromWidget(request?: unknown): Promise<void> {
  const target = preferredMainWindow() ?? (await createWindow());
  if (target.isMinimized()) target.restore();
  target.show();
  target.focus();
  const notify = (): void => {
    if (!target.isDestroyed()) target.webContents.send("pet:widget-open-overview", request);
  };
  if (target.webContents.isLoadingMainFrame()) target.webContents.once("did-finish-load", notify);
  else notify();
}

function knownAttachmentCwds(): Promise<string[]> {
  return desktopHost.callBusiness("startup/workspaces", {});
}

async function knownReplyAttachmentCwds(): Promise<string[]> {
  return [...new Set([...(await knownAttachmentCwds()), join(userHome(), "Downloads")])];
}

async function inspectKnownReplyAttachment(
  path: string,
): Promise<GatewayControlEventAttachment | null> {
  if (!isAbsolute(path)) return null;
  for (const cwd of await knownReplyAttachmentCwds()) {
    const attachment = await inspectReadableReplyAttachment(path, { cwd });
    if (attachment) return attachment;
  }
  return null;
}

async function inspectKnownReplyAttachments(
  paths: readonly string[],
): Promise<GatewayControlEventAttachment[]> {
  const attachments: GatewayControlEventAttachment[] = [];
  for (const path of paths) {
    const attachment = await inspectKnownReplyAttachment(path);
    if (!attachment) {
      throw new Error(`附件不在允许的附件目录内、属于敏感文件、格式无效或超过 10 MB：${path}`);
    }
    attachments.push(attachment);
  }
  return attachments;
}



/** Bring a CodeShell window forward with this Session open (notification click, notice item). */
function revealSessionWindow(sessionId: string): void {
  void (async () => {
    const target =
      findNotificationWindow(mainWindows, bridge?.panelOwnerWebContentsId(sessionId)) ??
      (await createWindow());
    if (target.isDestroyed()) return;
    if (target.isMinimized()) target.restore();
    target.show();
    target.focus();
    const open = () => {
      if (!target.isDestroyed()) target.webContents.send("notification:open-session", sessionId);
    };
    if (target.webContents.isLoadingMainFrame()) target.webContents.once("did-finish-load", open);
    else open();
  })().catch((error) =>
    dlog("main", "desktop_notification.open_session.failed", { sessionId, error: String(error) }),
  );
}

const nativeStartup = registerNativeStartup({
  ownsDesktopInstance,
  mainDirectory: __dirname,
  desktopHost,
  revealSessionWindow,
  notifierReady(value) { desktopNotifier = value; },
  mediaResponse: (request) => mediaPreviewService.respond(request),
  startMimi: () => mimiShell.start(),
  startGateway: () => imGatewayService.boot({
    event: (event) => {
      for (const window of BrowserWindow.getAllWindows())
        if (!window.isDestroyed()) window.webContents.send("im-gateway:event", event);
    },
    outcome: (result) => { void mimiRuntime.notices?.outboxResult(result); },
    ready: () => { void mimiRuntime.notices?.outboxReady(); },
    open: () => startMobileRemote({ mode: "tunnel" }),
    close: () => stopMobileRemote(),
    status: () => getMobileRemoteGatewayStatus(),
    pairingUrl: () => createMobileRemotePairingUrl(),
    petChat: (request) => dispatchGatewayPetChat({
      host: desktopHost.mimiDispatch,
      dispatcher: () => mimiRuntime.dispatcher,
      decisions: () => mimiRuntime.decisions,
      notices: () => mimiRuntime.notices,
      windows: mimiEventWindows,
    }, request),
    isPetChatReady: () => mimiRuntime.ready,
    isSessionRouteReady: () =>
      mimiRuntime.ready && mimiRuntime.sessions !== undefined,
    routeSession: sessionRouteHandler({
      bridge: () => mimiRuntime.sessions,
      replyToSession: async (request) => mimiRuntime.decisions?.replyToSession(request),
    }),
  }).catch((error) => dlog("main", "im_gateway.start_failed", { error: String(error) })),
  startPanelMedia: () => panelAppBridge.initializeMedia(),
  restoreMainWindow,
  startAutomations: startDesktopAutomations,
  sweepWorktrees: (trigger) => sweepStaleWorktrees(trigger),
});

async function startDesktopAutomations(initialWindowReady: Promise<BrowserWindow>) {
  // Register the scheduler while the first window hydrates. Native continuations
  // and notifications wait for their own services before touching that window.
  try {
    const announceAutomationSession = (meta: AutomationSessionMeta) => {
      taskInboxAutomationSessions.set(meta.sessionId, meta.cronJobId);
      void initialWindowReady.then(() => bridge?.broadcastAutomationSession(meta)).catch((error) =>
        dlog("main", "automation.session.broadcast.failed", { error: String(error) }),
      );
      markSessionTaskDirty(meta.sessionId);
      taskInboxService.markDirty("automation", meta.cronJobId);
    };
    const onAutomationNotice = (
      notice: import("../host/composition/automation-run.js").AutomationRunNotice,
    ) => {
      if (notice.type === "session") announceAutomationSession(notice.meta);
      else {
        taskInboxAutomationSessions.delete(notice.sessionId);
        markSessionTaskDirty(notice.sessionId);
      }
    };
    desktopHost.automationListeners.add(onAutomationNotice);
    taskInboxDisposers.push(() => desktopHost.automationListeners.delete(onAutomationNotice));
    // "Continue this conversation" jobs feed their prompt into the live session.
    const injectResumeTurn = createAutomationResumeTurn({
      bridge: () => bridge,
      notifyMissingTarget: (job) =>
        desktopNotifications.notifyMissingAutomationResumeTarget(desktopNotifier, job),
    });
    const schedulerReady = cron.start({
      dirty: (id) => taskInboxService.markDirty("automation", id),
      execute: async (job, signal) => {
        await initialWindowReady;
        signal.throwIfAborted();
        if (job.resumeSessionId && !isPetRuleScheduleJob(job))
          return injectResumeTurn(job.resumeSessionId, job.prompt, signal, job);
        throw Error("Native execution requires an existing Session");
      },
      online: () => nativeMimiScheduler.reconnect(),
      fireRule: async (rule, due, signal) => {
        await initialWindowReady;
        signal.throwIfAborted();
        return nativeMimiScheduler.effect(rule, due);
      },
      deliver: async (event) => {
        await initialWindowReady;
        if (event.type !== "job_start") {
          for (const [sessionId, jobId] of taskInboxAutomationSessions) {
            if (jobId === event.job.id) taskInboxAutomationSessions.delete(sessionId);
          }
        }
        taskInboxService.markDirty("automation", event.job.id);
        const notification = automationLifecycleNotification(event);
        if (!notification) return;
        await publishGatewayControlEvent(notification);
        desktopNotifications.notifyMissedAutomation(desktopNotifier, notification, event);
      },
    });
    await Promise.all([schedulerReady, initialWindowReady]);
    await mimiRuntime.startRules();

    agentNotificationBus.subscribe((envelope) =>
      desktopNotifications.notifyBackgroundResult(desktopNotifier, envelope),
    );
  } catch (err) {
    // Automation is non-critical to the GUI — never block startup on it.
    console.error("automation: failed to start", err);
  }

  taskInboxDisposers.push(
    agentNotificationBus.subscribe(() => taskInboxService.scheduleRefresh("legacy-run")),
  );
  taskInboxService?.start();

}
ipcMain.handle(
  "capabilities:setEnabled",
  async (
    event,
    target: RendererConfigurationTarget | null,
    id: string,
    on: boolean,
    opts?: { scope?: "user" | "project" },
  ) => {
    const scope = opts?.scope ?? "user";
    if (scope !== "user" && scope !== "project") {
      throw new Error("capabilities:setEnabled requires scope user|project");
    }
    if (scope === "user" && target !== null) {
      throw new Error("user capability changes do not accept project authority");
    }
    if (scope === "project" && target === null) {
      throw new Error("project capability changes require stable authority");
    }
    if (typeof id !== "string") throw new Error("capabilities:setEnabled requires id");
    const input = target === null
      ? { scope: "user" as const, target, id, on: Boolean(on) }
      : { scope: "project" as const, target, id, on: Boolean(on) };
    return desktopHost.callBusiness("capabilities/setEnabled", input, desktopHost.documentSignal(event));
  },
);
ipcMain.handle(
  "capabilities:setOverride",
  async (event, target: RendererConfigurationTarget, id: string, state: "inherit" | "on" | "off") => {
    if (typeof id !== "string") throw new Error("capabilities:setOverride requires id");
    if (state !== "inherit" && state !== "on" && state !== "off")
      throw new Error("capabilities:setOverride requires state inherit|on|off");
    return desktopHost.callBusiness("capabilities/setOverride", { target, id, state }, desktopHost.documentSignal(event));
  },
);
registerSourceCollectionIpc({
  ipcMain,
  open: (event) => openSourceCollectionOperation(event, (window) => mainWindows.has(window)),
});
registerLinkedFileSourceIpc({
  ipcMain,
  open: (event) =>
    openLinkedFileSourceOperation(
      event,
      (window) => mainWindows.has(window),
      remoteLinkIpc.storedSnapshot,
    ),
});
registerSourceCatalogIpc(ipcMain, desktopHost, (options) => dialog.showOpenDialog(options));
registerProfileSwitchIpc({
  ipcMain,
  ...hostedProfileSwitch(desktopHost),
  documentSignal: (event) => desktopHost.documentSignal(event),
  resolveTarget: resolveRendererConfigurationTarget,
  withMutation: (cwd, write) => {
    if (!bridge) throw new Error("桌面运行时尚未就绪，请稍后重试。");
    return bridge.withWebConfigurationMutation(cwd, write);
  },
});
registerProfileCatalogIpc(desktopHost);
registerProjectPanelIpc({
  ipcMain,
  requireRendererProjectPath,
  withMutation: (cwd, write) =>
    bridge ? bridge.withWebConfigurationMutation(cwd, write) : write(),
  onChanged: () => broadcastPanelAppsChanged(mainWindows),
  revokeAppId: (id) => panelAppBridge.revokeAppId(id),
  describeGuest: (guestId) => panelAppBridge.describeGuest(guestId),
  closeForPackageChange: (appId, matches) => panelAppBridge.closeForPackageChange(appId, matches),
  onCleanupError: (id, error) =>
    dlog("main", "panel_app.settings_cleanup_failed", {
      id,
      error: error instanceof Error ? error.message : String(error),
    }),
});

// ── Credentials (token/link store + cookie capture) ──────────────────
// cwd may be "" for no-repo contexts; project scope no-ops without a cwd.
const { remoteLinkIpc } = registerLinkCredentialIpc({
  withCaller: desktopHost.withDocumentCaller,
  mainWindows,
  bridge: () => bridge,
  linkDeviceOAuthBroker,
  managedCliInstallJobs,
  getMcpOAuthService,
  normalizeMcpOAuthLoginInput,
  captureLinkAccount,
});
prepareAccountGitHubLink = remoteLinkIpc.prepareGitHubLink;
const { assertRendererSessionAccess, deletingBrowserSessions, rendererBrowserSessionAccess } =
  registerBrowserSessionIpc({
    mainWindows,
    bridge: () => bridge,
    chromeNativeRegistration: nativeStartup.chromeRegistration,
  });
const deleteDesktopSession = registerSessionLifecycle({
  desktopHost, deletingBrowserSessions, rendererBrowserSessionAccess, mediaPreviewService,
  bridge: () => bridge, external: () => externalRuntime.service,
  deleted: id => taskInboxService.sessionIntent({ type: "sessionDeleted", sessionId: id }),
  quickChatOwnership, quickChatsReady: nativeStartup.quickChatsReady,
});

// Is a usable git binary available (PATH, or the configured git.path)? The
// marketplace UI uses this to show an "install Git" banner up front instead of
// only after a clone fails.
ipcMain.handle("git:check", async () => {
  await applyGitPathFromSettings();
  const available = isGitAvailable();
  const path = available ? (resolveGitPath() ?? undefined) : undefined;
  const installUrl = gitDownloadUrl();
  return {
    available,
    installUrl,
    ...(path ? { path } : {}),
    ...(!available ? { message: gitInstallGuidance({ includeUrl: false }) } : {}),
  };
});

registerSpeechIpc();
registerPluginLibraryIpc(desktopHost, cron);
ipcMain.handle("themes:list", async () => {
  const themes = await listInstalledThemes();
  return themes.map(installedThemeToPack);
});
ipcMain.handle(
  "themes:pickAndPreview",
  async (
    _e,
    kind?: unknown,
  ): Promise<{ cancelled: true } | { cancelled: false; path: string; preview: ThemePreview }> => {
    const options = themeImportDialogOptions(kind);
    const win = BrowserWindow.getFocusedWindow();
    const picked = win
      ? await dialog.showOpenDialog(win, options)
      : await dialog.showOpenDialog(options);
    const path = picked.filePaths[0];
    if (picked.canceled || !path) return { cancelled: true };
    const preview = await previewLocalTheme(path);
    return { cancelled: false, path, preview };
  },
);
ipcMain.handle("themes:install", async (_e, input: { path: string; reviewToken: string }) => {
  if (!input || typeof input.path !== "string" || typeof input.reviewToken !== "string") {
    throw new Error("themes:install requires { path, reviewToken }");
  }
  const installed = await installReviewedLocalTheme(input.path, input.reviewToken);
  const pack = installedThemeToPack(installed);
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send("themes:changed");
  }
  return pack;
});
ipcMain.handle("themes:uninstall", async (_e, id: string) => {
  if (typeof id !== "string") throw new Error("themes:uninstall requires an id");
  await uninstallTheme(id);
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send("themes:changed");
  }
  return { ok: true };
});



registerAttachmentsIpc({
  host: desktopHost,
  quickChatOwnership,
  deleteDesktopSession,
  assertQuickChatClaim,
});
registerAgentsMediaIpc({ host: desktopHost, mainWindows, mediaPreviewService });
registerSkillsMcpIpc({ host: desktopHost, getMcpOAuthService });
registerModelCatalogIpc(desktopHost);
ipcMain.handle("updater:check", async () => checkForUpdate());
ipcMain.handle("updater:download", async () => downloadUpdate());
ipcMain.handle("updater:install", async () => quitAndInstall());
ipcMain.handle("updater:status", async () => getLastStatus());
ipcMain.handle("app:version", () => app.getVersion());

desktopManagedRuntimes.registerIpc(
  ipcMain,
  (event) =>
    [...mainWindows].some(
      (window) => !window.isDestroyed() && window.webContents === event.sender,
    ) && event.senderFrame === event.sender.mainFrame,
);

const {
  startMobileRemote,
  stopMobileRemote,
  createMobileRemotePairingUrl,
  getMobileRemoteGatewayStatus,
} = mobileShell.registerIpc();
const { knownGitRoots } = desktopHost;

registerProjectAuthorityIpc({
  host: desktopHost,
  ipcMain,
  getAllWindows: () => BrowserWindow.getAllWindows(),
  showOpenDialog: (options) => dialog.showOpenDialog(options),
  applyGitPathFromSettings,
  projectStore,
  getBridge: () => bridge,
  getExternalRuntimeService: () => externalRuntime.service,
  getTrust,
  assertSessionId: assertDesktopSessionId,
  trackGitRoot: (root) => knownGitRoots.add(root),
  broadcastMobileProjects: () => mobileOrchestrator.broadcastProjects(),
  revealInFinder,
  openPath,
});

registerDialogPickerIpc();
ipcMain.handle("window:new", async () => {
  await createWindow();
});

ipcMain.handle("window:isFullscreen", async (e): Promise<boolean> => {
  return BrowserWindow.fromWebContents(e.sender)?.isFullScreen() ?? false;
});

registerWindowTitleBarIpc({ ipcMain, platform: process.platform, windows: () => mainWindows });

mimiShell.registerIpc();

const { externalRuntimeModelService } = registerExternalRuntimeIpc({
  callBusiness: desktopHost.callBusiness,
  externalRuntimeService: () => externalRuntime.service,
  externalRuntimeApprovals: () => externalRuntime.approvals,
});
const { sweepStaleWorktrees } = registerGitReviewIpc({ knownGitRoots, business: desktopHost.callBusiness, documentSignal: desktopHost.documentSignal });
registerWorkspaceFilesIpc({
  appRendererNavigation,
  mainWindows,
  assertRendererSessionAccess,
  business: desktopHost.callBusiness,
  documentSignal: desktopHost.documentSignal,
  turnHistory: desktopHost.turnHistory,
  terminal: desktopHost.workbenchTerminal,
});
// Authoritative no-repo conversation cwd (~/.code-shell/no-repo). The renderer
// is a thin client and must NOT recompute homedir() itself; it asks main so the
// path it writes capabilityOverrides to is byte-identical to the worker cwd.
ipcMain.handle("no-repo:cwd", async () => resolveNoRepoCwd());

registerConfigurationSettingsIpc(ipcMain, desktopHost);

async function applyRendererSettingsSideEffects(change: SettingsChange): Promise<void> {
  if (change.panelApps) invalidatePanelAppBindingGuard();
  if (change.git) void applyGitPathFromSettings();
  if (change.pet) mimiRuntime.notices?.settingsChanged();
  if (change.externalVisibility) await mimiRuntime.reconcileSources();
  if (change.panelApps) broadcastPanelAppsChanged(mainWindows);
  if (change.pluginCommands) broadcastPluginCommandsChanged(mainWindows);
}

registerMemoryIpc({ mainWindows, host: desktopHost });
ipcMain.handle("agent:pendingApprovals", async (event) => {
  appRendererNavigation.assertSender(event);
  const signal = desktopHost.documentSignal(event);
  const lines = await pendingMobileApprovals.replayForWindow(event.sender.id, signal);
  signal.throwIfAborted();
  return [
    ...lines.map((line) => JSON.parse(line).params).filter((item) =>
      bridge?.panelOwnerWebContentsId(item.sessionId) === event.sender.id),
    ...(externalRuntime.approvals?.pendingForWindow(event.sender.id) ?? []),
  ];
});
// Compatibility IPC uses the same snapshot grant as the workbench port. The
// native Pet surface reads only the application-owned Mimi session.
ipcMain.handle("agent:subscribe", async (event, sessionId: string, sinceSeq?: number) => {
  assertDesktopSessionId(sessionId);
  const cursor =
    typeof sinceSeq === "number" && Number.isSafeInteger(sinceSeq) && sinceSeq >= 0 ? sinceSeq : 0;
  appRendererNavigation.assertSender(event);
  const isPet = () =>
    mimiShell.windows().some((w) => !w.isDestroyed() && w.webContents === event.sender);
  if (!isPet()) return desktopHost.readWorkbenchOutput(event, sessionId, cursor);
  const frame = event.senderFrame;
  const assertPet = () => {
    appRendererNavigation.assertSender(event);
    if (!isPet() || frame !== event.sender.mainFrame || deletingBrowserSessions.has(sessionId))
      throw new Error("Pet output authority was revoked");
  };
  if (!mimiRuntime.dispatcher || sessionId !== (await mimiRuntime.dispatcher.getSessionId()))
    throw new Error("Pet output requires the Mimi session");
  assertPet();
  const snapshot = await bridge!.readSnapshot(sessionId, cursor);
  assertPet();
  return snapshot;
});
const sessionCatalogStore = hostCatalogClient(
  desktopHost.callBusiness,
  desktopHost.catalogListeners,
);
const { taskInboxService, listAllDiskSessions, archiveDiskSession, markSessionTaskDirty, userContinuedTask, observeWorkerTasks } =
  createDesktopTaskInbox({
    desktopHost, mainWindows, externalRuntime, worker: () => bridge,
    sessionProjection: () => mimiRuntime.projection?.getSnapshot(), sessionCatalogStore,
    taskInboxAutomationSessions, taskInboxDisposers, appRendererNavigation,
  });
let closeActivityHistory: (() => Promise<void>) | undefined;
registerDesktopOutputHistoryHost({
  activityHost: desktopHost,
  ipcMain,
  windows: () => [...mainWindows],
  archive: archiveDiskSession,
  historyWindows: () => {
    return [...mainWindows, ...mimiShell.windows()];
  },
  bridge: () => bridge,
  external: () => externalRuntime.service,
  mobile: mobileOrchestrator,
  registerCleanup: (cleanup) => {
    closeActivityHistory = cleanup;
  },
});
const sessionCatalogIpc = registerSessionCatalogIpc(
  ipcMain,
  () => {
    return [...mainWindows, ...mimiShell.windows()];
  },
  sessionCatalogStore,
  sessionCatalogStore.transcripts,
  desktopHost.documentSignal,
);
taskInboxDisposers.push(
  registerOptimizationLabHost({
    business: desktopHost.callBusiness,
    documentSignal: desktopHost.documentSignal,
    windows: () => [...mainWindows],
    settingsCwd: resolveNoRepoCwd,
    resolveTarget: resolveRendererConfigurationTarget,
    trust: getTrust,
    bridge: () => bridge,
  }),
);
backgroundWork.registerBackgroundWorkIpc(ipcMain, mainWindows, () => bridge);
const operationScope = {
  host: desktopHost,
  windows: () => [...mainWindows],
  enabled: taskInboxEnabled,
  isSessionRunning: (id: string) =>
    taskInboxAutomationSessions.has(id) ||
    bridge?.isSessionRunning(id) === true ||
    externalRuntime.service?.isSessionRunning(id) === true,
};
const disposeOperationBatchHost = registerOperationBatchHost({
  ...operationScope,
  bridge: () => bridge ?? undefined,
});
const disposeOperationResolutionHost = registerOperationResolutionHost(operationScope);
registerAutomationIpc(cron, desktopHost.documentSignal);
registerTrustNotificationIpc({
  host: desktopHost,
  externalRuntimeService: () => externalRuntime.service,
});
registerNativeShutdown({
  ownsDesktopInstance,
  restoreMainWindow,
  flushRenderers: () => sessionCatalogIpc.flushRenderers(),
  disposeOperationBatchHost,
  disposeOperationResolutionHost,
  stopIngress() {
    nativeStartup.stop();
    cloudEnvironment.dispose();
    taskInboxService.dispose();
    for (const dispose of taskInboxDisposers.splice(0)) dispose();
  },
  desktopHost,
  desktopModules,
  withdrawWindows() {
    mimiRuntime.withdraw();
    browserRuntime.closeAll();
    bridge?.kill();
  },
  stopMimi: mimiRuntime.stop,
  history: () => closeActivityHistory?.(),
  mimiShell,
  mobileShell,
  panelAppBridge,
  finalize: () => sessionCatalogIpc.close(),
});
