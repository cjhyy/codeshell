import { createDesktopTaskInbox } from "./shell/task-inbox.js";
import { createMimiPresenceShell } from "./shell/mimi-presence.js";
import { createPanelCookieAdapter, registerPanelWindowShell } from "./shell/panel-app.js";
import { petRemoteMemoryContext } from "./pet/pet-memory-host.js";
import { mimiTurnStores } from "../shared/mimi-turn-storage.js";
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
import { createExternalRuntimeModule } from "./external-runtime-module.js";
import { externalRuntimeMimiHost } from "./external-runtime-mimi-tools.js";
import { registerProjectPanelIpc } from "./project-panel-ipc.js";
import { registerProfileSwitchIpc, hostedProfileSwitch } from "./profile-switch-ipc.js";
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
  session,
  shell,
  safeStorage,
  powerMonitor,
} from "electron";
import { registerWindowTitleBarIpc } from "./window-titlebar.js";
import { registerCloudEnvironmentIpc } from "./cloud-environment-ipc.js";
import { registerNativeShutdown } from "./shell/shutdown.js";
import { registerNativeStartup } from "./shell/startup.js";
import { createDesktopManagedRuntimeWiring } from "./managed-runtime-wiring.js";
import { fileURLToPath, pathToFileURL } from "node:url";
import { AppRendererNavigation } from "./app-renderer-navigation.js";
import { dirname, resolve, isAbsolute, join } from "node:path";
import {
  SettingsManager,
  SessionManager,
  userHome,
  codeShellHome,
  setDefaultCredentialAccess,
  localCredentialAccess,
  sessionsRoot,
  previewLocalTheme,
  installReviewedLocalTheme,
  listInstalledThemes,
  uninstallTheme,
  type ThemePreview,
} from "@cjhyy/code-shell-core";
import {
  agentNotificationBus,
  getMergedCatalog,
  isGitAvailable,
  resolveGitPath,
  describeTranscribe,
} from "@cjhyy/code-shell-core/internal";
import { AgentBridge, resolveNoRepoCwd } from "./agent-bridge.js";
import {
  externalRuntimeToolContextForSession,
  externalRuntimeWorkspaceForSession,
} from "./external-runtime-tool-context.js";
import { createExternalRuntimeBackgroundWork } from "./external-runtime-background-work.js";
import { createExternalGoalRpcHandler } from "./external-runtime-goal-rpc.js";
import { buildExternalRuntimeHandoffFromEvents } from "./external-runtime-handoff.js";
import { parseExternalRuntimeModelKey } from "../shared/external-runtime-models.js";
import {
  requireRendererProjectPath,
} from "./renderer-project-path.js";
import { nativeMimiFollowUps } from "./desktop-host/mimi-follow-ups-client.js";
import {
  type PetSegmentClosureService,
} from "./pet/pet-segment-closure-service.js";
import {
  broadcastPetChatTranscriptUpdated,
  PET_CHAT_EVENT_CHANNEL,
  registerPetIpc,
} from "./pet/pet-ipc.js";
import {
  completePetHostActionReceipt,
  type PetHostActionReceiptRecorder,
} from "./pet/pet-host-action-completion.js";
import type { PetHostActionExecution } from "./pet/pet-dispatch-service.js";
import type { PetChatEvent } from "../preload/pet-api.js";
import {nativeMimiNoticeLedger} from "./desktop-host/mimi-notice-ledger-client.js";
import { currentMimiRuleDocument } from "./desktop-host/mimi-rules-client.js";
import type { MimiReplyRender } from "../shared/mimi-gateway-turn.js";
import { nativeMimiRecords } from "./desktop-host/mimi-records-client.js";
import { PetWorkDelegationHost } from "./pet/pet-work-delegation-host.js";
import { getSessionCwdIndex } from "./session-cwd-index.js";
import { wirePetNotices, type PetNoticeWiring } from "./pet/pet-notice-wiring.js";
import { withExternalDecisions } from "./pet/pet-notice-external-decisions.js";
import { createExternalSessionCatalog } from "./pet/pet-notice-external-sessions.js";
import { externalGoalNoticeSource } from "./pet/pet-notice-goal-reconcile.js";
import { createPetNoticeControls, type PetNoticeControls } from "./pet/pet-notice-ipc.js";
import { wireMimiNoticeTools } from "./pet/pet-mimi-notice-tools.js";
import { archivePetSessionsBySelector } from "./pet/pet-session-archive.js";
import { createPetFollowUpRules } from "./pet/pet-follow-up-rules.js";
import { wirePetProactive } from "./pet/pet-proactive-wiring.js";
import { NativeMimiScheduler } from "./desktop-host/mimi-scheduler-client.js";
import { isPetRuleScheduleJob } from "./pet/pet-rule-schedule.js";
import { nativeMimiWorkMemory } from "./desktop-host/mimi-work-client.js";
import type { PetArchiveAnchors } from "./pet/pet-segment-controller.js";
import { recordPetDelegationClosureBestEffort } from "./pet/pet-delegation-closure.js";
import {
  createSessionOutcomeFanout,
  createSessionOutcomeTap,
  feedSessionOutcomeTap,
  SessionOutcomeDeriver,
} from "./pet/session-outcome.js";
import {
  PetImDecisions,
  collectCurrentImDecisions,
  imDecisionWorkerActions,
} from "./pet/pet-im-decisions.js";
import { createOwnerReplyHandling, lastUserMessageIn } from "./pet/pet-notice-action-controls.js";
import { selectSessionsToArchive } from "./pet/pet-auto-archive.js";
import { buildMigrationSummary } from "@cjhyy/code-shell-pet";
import { materializeOutgoingAttachments } from "@cjhyy/code-shell-chat";
import { createReusableSessionResolver } from "./pet/reusable-session-resolver.js";
import type { MimiDispatchService } from "../shared/mimi-dispatch.js";
import {
  createBoundSessionHealth,
  createBoundSessionRunner,
  createSessionBridgeWiring,
  sessionRouteHandler,
  type SessionBridgeWiring,
} from "./pet/session-bridge-wiring.js";
import {
  petMemoryAutoExtractFromSettings,
  petMemoryAutoExtractSettingsPatch,
  resolvePetDelegatedPermissionMode,
} from "../shared/pet-settings.js";
import {
  sessionModelKeyFromSettings,
} from "../shared/session-model-default.js";
import { createExternalRuntimeHostSubmission } from "./external-runtime-host-submission.js";
import {
  persistedExternalRuntimeModelKey,
  isPersistedExternalRuntime,
} from "./mobile-remote/external-runtime-commands.js";
import { createPetRuntimeControlWorker } from "./pet/pet-runtime-control-worker.js";
import { createPetExternalRuntime } from "./pet/pet-external-runtime.js";
import { createPetExternalReplyModel } from "./pet/pet-external-reply-model.js";
import { resolveExternalRuntimeStartWorkspace } from "./external-runtime-start-workspace.js";
import { installedThemeToPack } from "./theme-pack-conversion.js";
import { themeImportDialogOptions } from "./theme-import-dialog.js";
import { SafeStorageCipher } from "./credential-cipher.js";
import { createDesktopModelRequestSigner } from "./model-request-signing-service.js";
import { McpOAuthService, type McpOAuthLoginInput } from "./mcp-oauth-service.js";
import { LinkDeviceOAuthBroker } from "./link-device-oauth.js";
import { type ManagedCliInstallResult } from "./link-cli-installer.js";
import { inspectReadableReplyAttachment } from "./image-read-service.js";
import { NativeMediaProtocol } from "./hosted-media-protocol.js";
import {
  partitionForSession,
} from "./browser-driver/active-guest.js";
import {
  beginBrowserRunForSession,
  browserRuntime,
  builtInBrowserHandoffGrants,
  chromeExtensionRuntimeService,
  interactiveBrowserBridgeForSession,
  panelAccessRequests,
} from "./browser-runtime/index.js";
import type { AutomationSessionMeta } from "./automation-host.js";
import { createAutomationResumeTurn } from "./automation-resume-turn.js";
import { automationLifecycleNotification } from "./automation-notification.js";
import { DesktopNotifier } from "./desktop-notifier.js";
import { findNotificationWindow } from "./native-desktop-notification.js";
import { registerNotificationFallback, showSystemNotification } from "./system-notification.js";
import * as desktopNotifications from "./desktop-notification-routes.js";
import type { CreateAutomationInput } from "./automation-service.js";
import { dlog } from "./desktop-logger.js";
import { cookieCredentialAutoRefresh } from "./cookie-credential-auto-refresh.js";
import { isBrowserPartition } from "../shared/browser-partition.js";
import {
  markAttachmentsSent,
  stageFileBytes,
  stageImageBytes,
  type InputAttachmentMeta,
} from "@cjhyy/code-shell-server/storage";
import {
  type GatewayControlEventAttachment,
  type GatewayControlEventInput,
  type PetChatControlRequest,
  type PetChatControlResult,
} from "./im-gateway-control-server.js";
import { registerImGatewayIpc } from "./im-gateway-ipc.js";
import { QuickChatOwnershipRegistry } from "./quick-chat-ownership.js";
import { revealInFinder, openPath } from "./desktop-services.js";
import { readSettings } from "./settings-service.js";
import { registerDesktopOutputHistoryHost } from "./session-output-history-host.js";
import { registerSessionCatalogIpc } from "./session-catalog-ipc.js";
import { hostCatalogClient } from "./desktop-host/catalog-client.js";
import * as backgroundWork from "./cc-room/background-work-ipc.js";
import { registerOptimizationLabHost } from "./optimization-lab-host.js";
import { taskInboxPetView } from "./task-inbox/task-inbox-pet-view.js";
import { assertDesktopSessionId } from "./session-validation.js";
import { getSessionEvents } from "./rawTranscript.js";
import { invalidatePanelAppBindingGuard, isPanelAppBoundToProject } from "./panel-apps-service.js";
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
import { bindWorkbenchInstance, createWorkbenchSurface, prepareNativeInstance } from "./shell/workbench-window.js";
import { getTrust, getTrustCachedSync } from "./trust-store.js";
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
    void reconcileExternalAdapters?.().catch((error) =>
      dlog("main", "pet.external.restart.failed", { error: String(error) }),
    );
  },
  applyRendererSettingsSideEffects,
);
setDesktopCredentialFiles(desktopHost.credentialCommand);
const { listDiskSessions, automation: cron } = desktopHost;
const renderMimiReply = (
  baseText: string,
  executions: MimiReplyRender["executions"],
  options: MimiReplyRender["options"],
) => desktopHost.callBusiness("mimi/renderReply", { baseText, executions, options });
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
const externalRuntime = createExternalRuntimeModule(() => {
  const externalBridge = bridge!;
  return {
    memoryInference: desktopHost.inferExternalMemory,
    approvals: {
      windows: () => mainWindows,
      ownerWebContentsId: (sessionId) => externalBridge.panelOwnerWebContentsId(sessionId),
      onPendingChange: (event) => mobileOrchestrator.mirrorExternalApproval(event),
    },
    service: {
      providerFactories: desktopHost.externalProviders,
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
      sessionStateChanged: (sessionId, active, ownerId) => {
        sendToOwnerWindow(ownerId, "externalRuntime:sessionState", { sessionId, active });
        markSessionTaskDirty(sessionId);
      },
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
        userContinuedTask(sessionId);
      },
      mimiTools: () => externalRuntimeMimiHost(petNotices, externalBridge),
    },
  };
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
let petStateAggregator: typeof desktopHost.mimiProjection | null = null;
let reconcileExternalAdapters: (() => Promise<void>) | null = null;
let petDispatchService: MimiDispatchService | null = null;
const nativeMimiScheduler = new NativeMimiScheduler(
  desktopHost.callBusiness,
  powerMonitor,
  (error) => dlog("main", "pet.followUp.scheduler.failed", { error: String(error) }),
);
let petRuleScheduler: import("./pet/pet-follow-up-rules.js").RuleSchedulerLifecycle | null = null;
// The dispatcher exists before its worker and durable stores finish loading.
// IM delivery shares the same completed initialization boundary as Pet IPC.
let petRuntimeReady = false;
let petHostActionReceiptService: PetHostActionReceiptRecorder | null = null;
let petNotices: PetNoticeWiring | null = null;
let petWorkInboxStore: ReturnType<typeof nativeMimiRecords>["workInbox"] | null = null;
const taskInboxDisposers: Array<() => void> = [];
const taskInboxAutomationSessions = new Map<string, string>();
let petImDecisions: PetImDecisions | null = null;
let unsubscribePetLongTaskStream: (() => void) | null = null;
let unsubscribePetReportStream: (() => void) | null = null;
let disposePetIpc: (() => void) | null = null;
let mcpOAuthService: McpOAuthService | null = null;
const linkDeviceOAuthBroker = new LinkDeviceOAuthBroker();
const managedCliInstallJobs = new Map<string, Promise<ManagedCliInstallResult>>();


const quickChatOwnership = new QuickChatOwnershipRegistry();
const quickChatOwnerCleanupRegistered = new Set<number>();

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
let sessionBridge: SessionBridgeWiring | undefined;

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

    const externalGoalSessions = new SessionManager();
    externalBridge.setExternalGoalRpcHandler(
      createExternalGoalRpcHandler({
        isExternalSession: (sessionId) => {
          if (externalRuntime.service?.get(sessionId)) return true;
          // The canonical model wins over an old external-runtime sidecar after
          // a user switches this task back to the native runtime.
          return isPersistedExternalRuntime(externalGoalSessions.readSessionState(sessionId));
        },
        authorize: (sessionId, callerId) => {
          assertDesktopSessionId(sessionId);
          const owner = [...mainWindows].find(
            (window) => !window.isDestroyed() && window.webContents.id === callerId,
          );
          if (!owner) throw new Error("goal controls require a live owner window");
          const existingOwner = externalBridge.panelOwnerWebContentsId(sessionId);
          if (existingOwner !== undefined && existingOwner !== callerId) {
            throw new Error("goal belongs to another window");
          }
        },
        prepareResume: async (sessionId, callerId) => {
          const service = externalRuntime.service;
          if (!service) throw new Error("external runtime service is unavailable");
          if (service.canResumeGoal(sessionId, callerId)) return;
          const state = externalGoalSessions.readSessionState(sessionId);
          const model = parseExternalRuntimeModelKey(persistedExternalRuntimeModelKey(state));
          if (!state || !model) throw new Error("external goal task is no longer available");
          const workspace = await resolveExternalRuntimeStartWorkspace(sessionId, state.cwd, {
            sessions: externalGoalSessions,
          });
          const ownerWindow = [...mainWindows].find(
            (window) => !window.isDestroyed() && window.webContents.id === callerId,
          );
          if (!ownerWindow) throw new Error("goal owner window has closed");
          const existingOwner = externalBridge.panelOwnerWebContentsId(sessionId);
          if (existingOwner !== undefined && existingOwner !== callerId) {
            throw new Error("goal belongs to another window");
          }
          const assertStartAuthority = () => {
            workspace.assertStartAuthority();
            const current = externalGoalSessions.readSessionState(sessionId);
            const currentModel = parseExternalRuntimeModelKey(
              persistedExternalRuntimeModelKey(current),
            );
            const owner = externalBridge.panelOwnerWebContentsId(sessionId);
            if (
              externalRuntime.service !== service ||
              ownerWindow.isDestroyed() ||
              (owner !== undefined && owner !== callerId) ||
              current?.startedAt !== state.startedAt ||
              current?.cwd !== state.cwd ||
              currentModel?.kind !== model.kind ||
              currentModel?.model !== model.model
            )
              throw new Error("external goal authority changed before startup");
          };
          await service.ensure({
            kind: model.kind,
            sessionId,
            cwd: workspace.cwd,
            mainRoot: workspace.mainRoot,
            assertStartAuthority,
            modelKey: state.model,
            ...(model.model ? { model: model.model } : {}),
            permissionMode: "default",
            hasGoal: true,
            initialContext: buildExternalRuntimeHandoffFromEvents(
              await getSessionEvents(sessionId),
            ),
            ownerWindow,
          });
        },
        service: () => {
          if (!externalRuntime.service) throw new Error("external runtime service is unavailable");
          return externalRuntime.service;
        },
        onGoalRead: (sessionId) => void petNotices?.reconcileGoalNotices(sessionId),
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
    const mimiRecords = nativeMimiRecords(desktopHost.callBusiness, desktopHost.mimiRecordListeners);
    const petMetadata = mimiRecords.metadata;
    const imRuntimeSessions = new SessionManager();
    const imExternalSubmissions = createExternalRuntimeHostSubmission({
      service: () => externalRuntime.service,
      sessions: imRuntimeSessions,
      ownerWindow: (sessionId) => {
        const owner = bridge?.panelOwnerWebContentsId(sessionId);
        return BrowserWindow.getAllWindows().find(
          (window) =>
            !window.isDestroyed() && (owner === undefined || window.webContents.id === owner),
        );
      },
    });
    const petWorkDelegationHost = new PetWorkDelegationHost({
      bridge,
      noWorkspaceCwd: resolveNoRepoCwd(),
      external: {
        modelKey: async ({ sessionId, cwd, reused }) => {
          const state = imRuntimeSessions.readSessionState(sessionId);
          if (reused || state) {
            if (!state) throw new Error("原工作会话不可用，未创建替代会话。");
            if (isPersistedExternalRuntime(state)) {
              const model = persistedExternalRuntimeModelKey(state);
              if (!model) throw new Error("外部会话模型不可用，未切换到 API 模型。");
              return model;
            }
            return state.modelConnectionId ?? null;
          }
          return sessionModelKeyFromSettings(new SettingsManager(cwd, "full").get());
        },
        run: imExternalSubmissions.run,
      },
      // Read per launch: a settings change applies to the next delegation. Like
      // the composer, a trusted project's default mode overrides the user's; an
      // unreadable settings file falls back to asking.
      permissionMode: async ({ cwd }) => {
        try {
          const user = await readSettings("user");
          const trusted = getTrustCachedSync(cwd) === "trusted";
          const project = trusted ? await readSettings("project", cwd) : null;
          return resolvePetDelegatedPermissionMode({ user, project });
        } catch {
          return "default";
        }
      },
      resolveSessionCwd: async (sessionId) => {
        const entry = await getSessionCwdIndex().refresh(sessionId);
        return entry?.status === "confirmed" ? (entry.workspaceRoot ?? entry.cwd) : undefined;
      },
      channelLabel: (channel) =>
        imGatewayService.ownerChannels().find((entry) => entry.id === channel)?.label,
    });
    const petWorkMemory = nativeMimiWorkMemory(desktopHost.callBusiness);
    const aggregator = desktopHost.mimiProjection;
    petStateAggregator = aggregator;
    taskInboxDisposers.push(
      aggregator.subscribe((event) => {
        if (event.kind === "session-upsert") markSessionTaskDirty(event.session.agentSessionId);
        else if (event.kind === "session-remove") markSessionTaskDirty(event.sessionId);
        else if (event.kind === "reset") {
          for (const source of ["session", "subagent", "external-runtime"] as const)
            taskInboxService.scheduleRefresh(source);
        }
      }),
    );

    const reconcileSources = async () => aggregator.sources(
      (await mobileOrchestrator.projectList().catch(() => [])).map((project) => project.path),
    );
    reconcileExternalAdapters = reconcileSources;

    // The topic-segment controller is created inside petInitialization once the
    // durable pet session id is known; until then the dispatch service holds a
    // stable wrapper that no-ops (beginTurn → undefined; closure → nothing).
    let petSegmentController: ReturnType<typeof petWorkMemory.controller> | null = null;
    const longTaskStore = desktopHost.mimiTasks;
    taskInboxDisposers.push(
      longTaskStore.subscribe(() => taskInboxService.scheduleRefresh("mimi-delegation")),
    );
    // The one interpreter of Session streams (see createSessionOutcomeTap below);
    // the bound-Session bridge reads its outcomes from `sessionOutcomes`.
    const sessionOutcomeDeriver = new SessionOutcomeDeriver();
    const sessionOutcomes = createSessionOutcomeFanout();
    // Desktop external-runtime Sessions (Codex / Claude Code run here in Main).
    const externalSessions = createExternalSessionCatalog({
      runtime: () => externalRuntime.service,
      readState: (id) => externalGoalSessions.readSessionState(id),
    });
    // Mimi's own Session id, once known: rules and watches never apply to it.
    let mimiSessionId: string | undefined;
    void petMetadata
      .ensure()
      .then((metadata) => {
        mimiSessionId = metadata.petSessionId;
        externalBridge.setMimiSession(mimiSessionId);
        desktopHost.setStreamView(mimiSessionId, true);
      })
      .catch(() => undefined);
    const notices = wirePetNotices({
      rules: desktopHost.mimiRules,
      ledger:nativeMimiNoticeLedger(desktopHost.callBusiness),
      userDataDir: app.getPath("userData"),
      isMimiSession: (sessionId) => sessionId === mimiSessionId,
      bridge,
      projection: aggregator,
      longTasks: longTaskStore,
      sessionRoutes: () => sessionBridge?.routes,
      gateway: imGatewayService,
      outbox: {
        publish: (event, owner) => imGatewayService.publish(event, owner),
        revoke: (deliveryKey) => imGatewayService.revoke(deliveryKey),
        state: (deliveryKey) => imGatewayService.deliveryState(deliveryKey),
      },
      notifyDesktop: async (input) => desktopNotifier?.notify(input),
      readSettings: () => new SettingsManager(resolveNoRepoCwd(), "full").getForScope("user"),
      presence: {
        getSystemIdleTimeSec: () => powerMonitor.getSystemIdleTime(),
        hasFocusedWindow: () => BrowserWindow.getFocusedWindow() !== null,
      },
      powerEvents: powerMonitor,
      focusEvents: app,
      hasLiveWorker: () => bridge?.hasLiveWorker() ?? false,
      externalSessions,
      externalGoals: externalGoalNoticeSource({
        sessionsRootDir: sessionsRoot(),
        readState: (id) => externalGoalSessions.readSessionState(id),
        isRunning: (id) => externalRuntime.service?.isSessionRunning(id) === true,
      }),
      externalApprovals: {
        approvals: () => externalRuntime.approvals,
        subscribe: (listener) => externalRuntime.subscribeApprovals(listener),
      },
      onWorkerLost: (keep) => sessionOutcomeDeriver.reset(keep),
      lastUserMessage: async (sessionId) => lastUserMessageIn(await getSessionEvents(sessionId)),
    });
    petNotices = notices;
    let petNoticeControls: PetNoticeControls | undefined;
    const writePetNotificationSettings = async (notifications: Record<string, unknown>) => {
      await desktopHost.callBusiness(
        "settings/patch",
        {
          scope: "user",
          patch: { pet: { notifications } },
        },
        currentMimiRuleDocument(),
      );
    };
    // Mimi's Notices / Triggers / ManageTrigger / NotificationSettings (design §4.7).
    const mimiNoticeTools = wireMimiNoticeTools({
      bridge,
      isMimiSession: (sessionId) => sessionId === mimiSessionId,
      ledger: notices.ledger,
      controls: () => petNoticeControls,
      settingsView: notices.settingsView,
      writeNotificationSettings: writePetNotificationSettings,
      channels: () => imGatewayService.ownerChannels(),
      sessionTitle: notices.sessionTitle,
      isOwnerConversation: (channel, target) =>
        imGatewayService.isOwnerConversation(channel, target),
    });
    const petWorkInbox = mimiRecords.workInbox;
    petWorkInboxStore = petWorkInbox;
    const turnStores = mimiTurnStores((command) => desktopHost.callBusiness("mimi/turnStorage", command));
    // Built inside petInitialization once the durable pet session id is known.
    let petSegmentClosureService: PetSegmentClosureService | null = null;
    const longTaskCoordinator = longTaskStore.configure({
      worker: createPetRuntimeControlWorker({
        worker: bridge,
        isExternal: imExternalSubmissions.isExternal,
        service: () => externalRuntime.service,
      }),
      launcher: petWorkDelegationHost,
      onDelegationStarted: (task) => notices.armDelegationRule(task),
      onTaskClosed: async (task) => {
        let message: string | undefined;
        let continued = false;
        let closureHostActions: PetHostActionExecution[] | undefined;
        try {
          if (petDispatchService) {
            const report = await petDispatchService.reportLongTaskClosure(task);
            message = report.text;
            continued = report.continued;
            closureHostActions = report.hostActions;
            // The closure manager runs outside the renderer-initiated chat IPC.
            // Its stream is owner-window scoped, so other open Mimi surfaces can
            // miss the final assistant reply even though it is durable on disk.
            // Invalidate every window after agent/run settles; each renderer
            // rehydrates the canonical transcript and naturally deduplicates a
            // reply it already received through the live stream.
            broadcastPetChatTranscriptUpdated(BrowserWindow.getAllWindows(), {
              taskId: task.id,
            });
          }
        } catch (error) {
          // The notice router still templates a result from the task's facts
          // when Mimi cannot compose one (for example while the worker restarts).
          dlog("main", "pet.longTask.reply.failed", { error: String(error), taskId: task.id });
        }

        // A successful continuation is an internal manager hand-off. Otherwise
        // the closure's GatewayReply is a DRAFT (text + validated files/button):
        // the router delivers it as the one owner-facing message for the chain.
        if (continued) return;
        const enriched =
          message === undefined
            ? undefined
            : await renderMimiReply(message, closureHostActions, {
                attachmentKinds: task.completionTarget?.replyAttachmentKinds,
              });
        // The closure manager's final assistant text is only an internal
        // acknowledgement after GatewayReply; show the routed body instead.
        const draftAccepted = closureHostActions?.some(
          (execution) => execution.kind === "gatewayReply" && execution.ok,
        );
        if (draftAccepted && enriched && task.completionTarget && petHostActionReceiptService) {
          await completePetHostActionReceipt({
            recorder: petHostActionReceiptService,
            input: {
              petSessionId: await petDispatchService!.getSessionId(),
              clientMessageId: task.originClientMessageId,
              receiptId: `${task.id}:${task.attempt}:${task.status}`,
              executions: closureHostActions ?? [],
              authoritativeMessage: enriched.text,
              replaceAssistant: true,
              deliveryChannel: task.completionTarget.channel,
            },
            publish: (receiptEvent) => {
              for (const window of BrowserWindow.getAllWindows()) {
                if (!window.isDestroyed())
                  window.webContents.send(PET_CHAT_EVENT_CHANNEL, receiptEvent);
              }
            },
          }).catch((error) =>
            dlog("main", "pet.longTask.gatewayReceipt.failed", {
              taskId: task.id,
              error: String(error),
            }),
          );
        }
        await notices.notifyTaskClosed(task, {
          ...(enriched ? { text: enriched.text } : {}),
          ...(enriched && (enriched.button || enriched.attachments.length > 0)
            ? {
                media: {
                  ...(enriched.button ? { button: enriched.button } : {}),
                  ...(enriched.attachments.length > 0 ? { attachments: enriched.attachments } : {}),
                },
              }
            : {}),
        });
      },
      onTaskWorkMemory: async (task) => {
        const recorded = await recordPetDelegationClosureBestEffort(
          petSegmentController,
          {
            dedupeKey: `${task.id}:${task.attempt}:${task.status}`,
            objective: task.objective,
            outcome: task.status === "completed" ? "completed" : "failed",
            ...(task.workspacePath ? { workspace: task.workspacePath } : {}),
            sessionRef: task.sessionId,
          },
          (error) =>
            dlog("main", "pet.longTask.memory.failed", { taskId: task.id, error: String(error) }),
        );
        if (!recorded) throw new Error("Pet work-memory distillation remains pending");
      },
      onBackgroundError: (operation, error) => {
        dlog("main", `pet.longTask.${operation}.failed`, { error: String(error) });
      },
    });
    const decisionBridge = bridge;
    petImDecisions = new PetImDecisions({
      // The worker's decisions and the desktop external runtimes' (Codex / Claude Code).
      ...withExternalDecisions(
        notices.externalDecisions,
        {
          read: async () => {
            const [lines, taskSnapshot] = await Promise.all([pendingMobileApprovals.replayForMimi(), longTaskStore.getSnapshot()]);
            return collectCurrentImDecisions(
              aggregator.getSnapshot(),
              taskSnapshot.tasks,
              lines,
              notices.decisions.deliveryFor,
            );
          },
          ...imDecisionWorkerActions(
            (method, params, timeoutMs, options) =>
              decisionBridge.requestWorker(method, params, timeoutMs, options),
            (params) => mobileOrchestrator.broadcastApprovalResolved(params),
          ),
        },
        (source, error) =>
          dlog("main", "pet.im-decision.read_failed", { source, error: String(error) }),
      ),
      // The router decides whether a prompt goes to IM (presence, caps) and
      // where; its ledger records hold each prompt's lifecycle.
      router: notices.router,
      isOwnerConversation: notices.decisions.isOwnerConversation,
      ownerChannelIsDirect: notices.decisions.ownerChannelIsDirect,
      isAway: notices.decisions.isAway,
      decisionStatus: notices.decisions.decisionStatus,
      projectionLive: notices.decisions.projectionLive,
      workerGone: notices.decisions.workerGone,
      projection: aggregator,
      nudges: [notices.decisions.onBlocked],
      onAwayChange: notices.decisions.onAwayChange,
      onError: (error) => dlog("main", "pet.im-decision.failed", { error: String(error) }),
      // Owner replies are read by a model against the open items (no text patterns).
      ...createOwnerReplyHandling({
        router: notices.router,
        cwd: resolveNoRepoCwd(),
        accounting: {
          sessionsRootDir: sessionsRoot(),
          sessionId: () => mimiSessionId,
          purpose: "pet_notice_reply",
        },
        externalReplyModel: createPetExternalReplyModel({
          service: () => externalRuntime.service,
          cwd: resolveNoRepoCwd(),
        }),
        worker: bridge,
        external: () => externalRuntime.service ?? undefined,
        sessions: () => aggregator.getSnapshot().sessions,
        longTasks: {
          get: (id) => longTaskStore.get(id),
          control: (r) => longTaskCoordinator.control(r),
        },
        readEvents: (sessionId) => getSessionEvents(sessionId),
        workspace: async (sessionId) => {
          const entry = await getSessionCwdIndex().refresh(sessionId);
          return entry?.status === "confirmed" ? (entry.workspaceRoot ?? entry.cwd) : undefined;
        },
        openPath: (path) => shell.openPath(path),
        revealPath: (path) => shell.showItemInFolder(path),
        openExternal: (url) => shell.openExternal(url),
        locateSession: (sessionId) => revealSessionWindow(sessionId),
        onError: (error) => dlog("main", "pet.notice.reply_failed", { error: String(error) }),
      }),
    });
    petImDecisions.start();
    // One interpretation of each Session event, handed to the long task and
    // the notice rules (see createSessionOutcomeTap). Which of them reports a
    // run is decided by the delivery plan, not by who hears of it first.
    const observeSessionOutcome = createSessionOutcomeTap(
      {
        coordinator: (sessionId, event, outcomes) =>
          void longTaskCoordinator
            .observeSessionEvent(sessionId, event, outcomes)
            .catch((error) => dlog("main", "pet.longTask.stream.failed", { error: String(error) })),
        watcher: (sessionId, outcomes) => notices.observeSessionOutcomes(sessionId, outcomes),
        stream: (sessionId, event, outcomes) => {
          notices.sessionEvent(sessionId, event);
          sessionOutcomes.emit(sessionId, event, outcomes);
        },
      },
      sessionOutcomeDeriver,
    );
    // Native worker lines and desktop external runtimes (owner window or not).
    unsubscribePetLongTaskStream = feedSessionOutcomeTap({
      sources: bridge,
      observe: observeSessionOutcome,
      deriver: sessionOutcomeDeriver,
      runtimeEnded: notices.externalRuntimeEnded,
    });
    // One root for both the Sessions disclosure tool and the resume resolver,
    // so the directory Mimi reads and the one selectors resolve against can
    // never drift apart.
    const petSessionsRootDir = sessionsRoot();
    const hostActionReceiptService: PetHostActionReceiptRecorder = {
      record: (input) => desktopHost.callBusiness("mimi/recordReceipt", input),
    };
    petHostActionReceiptService = hostActionReceiptService;
    // Briefs and the heartbeat are system schedule rules on the same scheduler.
    const petProactive = wirePetProactive({
      notices,
      userDataDir: app.getPath("userData"),
      cwd: resolveNoRepoCwd(),
      accounting: {
        sessionsRootDir: petSessionsRootDir,
        sessionId: () => mimiSessionId,
        purpose: "pet_brief",
      },
      externalReplyModel: createPetExternalReplyModel({
        service: () => externalRuntime.service,
        cwd: resolveNoRepoCwd(),
      }),
      tasks: async () => (await longTaskStore.getSnapshot()).tasks,
      projection: () => aggregator.getSnapshot(),
      log: (event, data) => dlog("main", event, data),
    });
    // Follow-ups are schedule rules; the old follow-ups.json is deleted, not migrated.
    const followUpRuntime = await createPetFollowUpRules({
      fireSystem: () => petProactive.fire,
      rules: notices.ruleStore,
      makeScheduler: (fire) => nativeMimiScheduler.configure(fire),
      sessions: () => aggregator.getSnapshot().sessions,
      makeViews: (registered) => nativeMimiFollowUps(desktopHost.callBusiness, registered),
      tasks: longTaskStore,
      longTasks: longTaskCoordinator,
      submitNotice: notices.submitNotice,
      dispatch: () => petDispatchService,
      onError: (error) => dlog("main", "pet.followUp.wake.failed", { error: String(error) }),
      log: (event, data) => dlog("main", event, data),
    });
    const { petFollowUps, followUpHost } = followUpRuntime;
    petRuleScheduler = followUpRuntime.coordinator;
    void petProactive.start();
    // Entering a Work Session from a chat: the store, bridge, bind executor
    // and reply delivery are composed in session-bridge-wiring.ts so this
    // root only names the collaborators it already owns.
    const worker = bridge;
    sessionBridge = createSessionBridgeWiring({
      routesFilePath: resolve(app.getPath("userData"), "pet", "conversation-session-routes.json"),
      resolveSelector: createReusableSessionResolver(petSessionsRootDir),
      createRunner: (onTurn) =>
        createBoundSessionRunner(worker, aggregator, onTurn, sessionOutcomes, {
          external: {
            isExternal: imExternalSubmissions.isExternal,
            isRunning: imExternalSubmissions.isRunning,
            run: imExternalSubmissions.runBound,
            stop: imExternalSubmissions.stop,
          },
        }),
      health: createBoundSessionHealth(aggregator, petSessionsRootDir),
      describeStatus: async (route) => `当前在「${route.sessionTitle}」中。发送 /mimi 可退出。`,
      publish: (event) => publishGatewayControlEvent(event),
      // The conversations a turn's reply goes to come from the delivery plan.
      replyRoutes: (sessionId) => notices.deliveries.replyRoutes(sessionId),
      onDeliveryError: (error, turn) =>
        dlog("main", "pet.session.reply.retry", {
          sessionId: turn.sessionId,
          turnId: turn.turnId,
          error: String(error),
        }),
    });
    await sessionBridge.recoverOnStartup().catch(() => undefined);
    petDispatchService = desktopHost.mimiDispatch.configure({
      worker: bridge,
      hostCwd: resolveNoRepoCwd(),
      externalRuntime: createPetExternalRuntime({
        service: () => externalRuntime.service,
        cwd: resolveNoRepoCwd(),
      }),
      segmentController: {
        requestContextClear: async () => {
          if (!petSegmentController) throw new Error("Pet work-memory sink is not ready");
          await petSegmentController.requestContextClear();
        },
        beginTurn: async (clientMessageId) => petSegmentController?.beginTurn(clientMessageId),
        completeSegmentClosure: (closed) =>
          petSegmentController?.completeSegmentClosure(closed) ?? Promise.resolve(),
        onDelegationClosed: (closure) =>
          petSegmentController?.onDelegationClosed(closure) ?? Promise.resolve(),
      },
      validateFollowUpContinuation: followUpRuntime.validateContinuation,
      taskInbox: async () => {
        if (!taskInboxService || !taskInboxEnabled()) throw new Error("Task inbox is unavailable");
        return taskInboxPetView(await taskInboxService.reconcile());
      },
      // Atomic CodeShell capabilities Mimi may request via her host-action
      // tools; each runs only after her turn, and the real outcome is folded
      // into the reply. The key set gates which tools the worker exposes.
      recentProactive: mimiNoticeTools.recentProactive,
      noticeTurns: mimiNoticeTools.turnGate,
      hostActions: {
        ...mimiNoticeTools.hostActions,
        mobileRemote: async (payload) => {
          if (payload.action === "close") {
            await stopMobileRemote();
            return { action: "close" };
          }
          if (payload.action !== "open") throw new Error("invalid mobile-remote request");
          const opened = await startMobileRemote({ mode: "tunnel" });
          return {
            action: "open",
            url: opened.url,
            pairingUrl: opened.pairingUrl,
            expiresAt: opened.expiresAt,
          };
        },
        // A notice rule for the asking conversation (an active long task keeps reporting).
        sessionWatch: notices.sessionWatch({
          refreshCatalog: () => aggregator.refreshCatalog(false),
          sessions: () => aggregator.getSnapshot().sessions,
          longTasks: {
            activeForSession: (sessionId) => longTaskStore.activeForSession(sessionId),
            watchSession: (input) => longTaskCoordinator.watchSession(input),
            reconcileNow: () => longTaskCoordinator.reconcileNow(),
          },
          goals: externalGoalSessions,
        }),
        followUpMutation: followUpHost,
        sessionBind: async (payload, context) =>
          sessionBridge
            ? sessionBridge.sessionBindExecutor(payload, context)
            : Promise.reject(new Error("session bridge is unavailable")),
        sessionArchive: async (payload) => {
          if (payload.action !== "archive" || !Array.isArray(payload.sessionIds)) {
            throw new Error("invalid session archive request");
          }
          const selectors = payload.sessionIds.filter(
            (value): value is string => typeof value === "string",
          );
          if (selectors.length !== payload.sessionIds.length) {
            throw new Error("invalid session archive request");
          }
          return archivePetSessionsBySelector({
            selectors,
            // By-id archive must not be limited to a page of recent sessions.
            listSessions: listAllDiskSessions,
            archiveSession: archiveDiskSession,
            refreshCatalog: () => aggregator.refreshCatalog(true, { full: true }),
          });
        },
        outboundMessage: async (payload) => {
          const targetId = typeof payload.targetId === "string" ? payload.targetId : "";
          const text = typeof payload.text === "string" ? payload.text : "";
          const paths = Array.isArray(payload.attachmentPaths) ? payload.attachmentPaths : [];
          if (
            !targetId ||
            !text.trim() ||
            paths.length > 4 ||
            !paths.every((path) => typeof path === "string")
          ) {
            throw new Error("invalid outbound message request");
          }
          const attachmentMetadata = await inspectKnownReplyAttachments(paths as string[]);
          const attachments = await materializeOutgoingAttachments(attachmentMetadata);
          const target = await imGatewayService.sendOwnerMessage(targetId, text, attachments);
          return {
            targetId: target.id,
            channel: target.channel,
            label: target.label,
            accepted: true,
            // Carry the delivered body back so the Mimi bubble can show what was
            // actually sent instead of a bare receipt. Only reached once
            // sendOwnerMessage resolved, so this text is what the platform took.
            text: text.trim(),
            ...(attachments.length > 0 ? { attachmentCount: attachments.length } : {}),
          };
        },
        gatewayReply: async (payload) => {
          const text = typeof payload.text === "string" ? payload.text.trim() : "";
          const button = payload.button;
          const paths = Array.isArray(payload.attachmentPaths) ? payload.attachmentPaths : [];
          if (
            paths.length > 4 ||
            !paths.every((path) => typeof path === "string") ||
            !text ||
            (button !== undefined &&
              (!button ||
                typeof button !== "object" ||
                Array.isArray(button) ||
                typeof (button as Record<string, unknown>).text !== "string" ||
                typeof (button as Record<string, unknown>).url !== "string"))
          ) {
            throw new Error("invalid Gateway reply request");
          }
          const attachments = await inspectKnownReplyAttachments(paths as string[]);
          return {
            text,
            ...(button ? { button } : {}),
            ...(attachments.length > 0 ? { attachments } : {}),
          };
        },
      },
      remoteContext: () => petRemoteMemoryContext(getMobileRemoteGatewayStatus()),
      listWorkspaces: () => mobileOrchestrator.projectList(),
      listFollowUps: (model) =>
        petFollowUps.listOpen({ allowGenerate: !parseExternalRuntimeModelKey(model) }),
      listOutboundTargets: async () =>
        imGatewayService.listOwnerMessageTargets().map((target) => ({
          id: target.id,
          channel: target.channel,
          label: target.label,
          maxTextLength: target.maxTextLength,
          attachments: target.attachments,
          maxAttachments: target.maxAttachments,
          maxAttachmentBytes: target.maxAttachmentBytes,
          // Mimi labels an unproven WeChat context instead of the host hiding it.
          proactiveReady: target.proactiveReady,
        })),
      replyAttachmentRoots: knownReplyAttachmentCwds,

    });
    const processingPetReports = new Set<string>();
    const deliveredPetReports = turnStores.reports;
    unsubscribePetReportStream = bridge.subscribePetReports(async (event) => {
      if (processingPetReports.has(event.reportId)) return;
      processingPetReports.add(event.reportId);
      try {
        if (await deliveredPetReports.has(event.reportId)) return;
        const task = await longTaskStore.activeForSession(event.sessionId);
        if (!petDispatchService) throw new Error("Mimi dispatch service is unavailable");
        const report = await petDispatchService.reportSessionMessage(
          {
            sourceSessionId: event.sessionId,
            reportId: event.reportId,
            message: event.message,
            ...(event.attachmentPaths ? { attachmentPaths: event.attachmentPaths } : {}),
            ...(event.deliveryRequest ? { deliveryRequest: event.deliveryRequest } : {}),
          },
          task,
        );
        if (!event.deliveryRequest) {
          // Mimi's draft for an IM-started task's origin; the delivery plan
          // names everyone else, and the router sends (quiet hours, caps, digest).
          const enriched = report.routedToOrigin
            ? await renderMimiReply(report.text, report.hostActions, {
                attachmentKinds: task?.completionTarget?.replyAttachmentKinds,
              })
            : undefined;
          await notices.notifySessionReport({
            sessionId: event.sessionId,
            reportId: event.reportId,
            message: event.message,
            ...(task ? { task } : {}),
            ...(enriched ? { composed: enriched } : {}),
          });
        } else if (report.hostActions?.length && petHostActionReceiptService) {
          const enriched = await renderMimiReply(
            report.text,
            report.hostActions,
            {
              attachmentKinds: [],
            },
          );
          await completePetHostActionReceipt({
            recorder: petHostActionReceiptService,
            input: {
              petSessionId: await petDispatchService.getSessionId(),
              clientMessageId: `pet-report:${event.reportId}`,
              executions: report.hostActions,
              authoritativeMessage: enriched.text,
              replaceAssistant: true,
            },
            publish: (receiptEvent) => {
              for (const window of BrowserWindow.getAllWindows()) {
                if (!window.isDestroyed()) {
                  window.webContents.send(PET_CHAT_EVENT_CHANNEL, receiptEvent);
                }
              }
            },
          });
        }
        await deliveredPetReports.mark(event.reportId);
        dlog("main", "pet.report.delivered_to_mimi", {
          reportId: event.reportId,
          sourceSessionId: event.sessionId,
          routedToOrigin: report.routedToOrigin,
          ...(task ? { taskId: task.id } : {}),
          attachmentCount: event.attachmentPaths?.length ?? 0,
          ...(event.deliveryRequest ? { deliveryChannel: event.deliveryRequest.channel } : {}),
        });
      } catch (error) {
        dlog("main", "pet.report.failed", {
          reportId: event.reportId,
          sessionId: event.sessionId,
          error: String(error),
        });
        throw error;
      } finally {
        processingPetReports.delete(event.reportId);
      }
    });
    const petInitialization = (async () => {
      await aggregator.start();
      await reconcileSources();
      await Promise.all([
        notices.ready,
        petWorkInbox.load(),
        turnStores.receipts.load(),
        petWorkMemory.load(),
      ]);
      // Build the topic-segment controller now that the pet session id is
      // resolved. Range archival rides the generic archive_range worker query;
      // dispatch currently passes no turnRange, so it stays dormant.
      const { petSessionId } = await petMetadata.ensure();
      const petBridge = bridge;
      const archivePetRange = async (
        sessionId: string,
        range: { start: number; end: number },
        anchors?: PetArchiveAnchors,
      ): Promise<{ before: number; after: number }> => {
        const response = await petBridge.requestWorker(
          "agent/query",
          {
            type: "archive_range",
            sessionId,
            start: range.start,
            end: range.end,
            ...(anchors ?? {}),
          },
          { meta: { origin: "host", producer: "pet-archive-range" } },
        );
        if (!response.ok) throw new Error(response.message);
        const data = (response.result as { data?: { before?: number; after?: number } })?.data;
        return { before: data?.before ?? 0, after: data?.after ?? 0 };
      };
      // Shared by the segment-closure pipeline and the startup migration below:
      // whether the user has auto-memory extraction enabled. Extraction (not
      // just archival) is what writes journal entries, so both consumers need
      // the same read of this preference.
      const autoExtractEnabled = () => desktopHost.callBusiness("mimi/extractionAllowed", {});
      petSegmentClosureService = {
        close: (input) => desktopHost.callBusiness("mimi/closeSegment", input),
        backfill: (segments, now) => desktopHost.callBusiness("mimi/backfillSegments", { segments, now }),
        readSegmentMessages: (range) => desktopHost.callBusiness("mimi/segmentMessages", range),
      };
      const closureService = petSegmentClosureService;
      // Defense-in-depth against a segment's range being archived twice.
      // archive_range uses absolute message indices; a second archive of the
      // same segment would run on now-shifted indices and remove the wrong
      // turns. The controller serializes beginTurn to prevent a double close,
      // and this set guarantees at-most-once archival per segment regardless.
      const closedSegmentIds = new Set<string>();
      petSegmentController = petWorkMemory.controller({
        petSessionId,
        archiveRange: archivePetRange,
        // The dispatcher calls this after the boundary turn settles, so the
        // exclusive-end message is guaranteed to exist for journal range math.
        onSegmentClosed: async (closed) => {
          if (closedSegmentIds.has(closed.segmentId)) return;
          closedSegmentIds.add(closed.segmentId);
          await closureService
            .close(closed)
            .catch((error) => dlog("main", "pet.closure.failed", { error: String(error) }));
        },
      });
      // Startup compensation: a segment whose closure was interrupted by app exit
      // still has no journal entry. Recover those (journal + memory only; the
      // range was — or will be — archived by the live path, so backfill never
      // re-archives). Fire-and-forget; never blocks pet initialization.
      const backfillPromise = closureService
        .backfill(petWorkMemory.allSegments(), Date.now())
        .catch((error) => dlog("main", "pet.closure.backfill.failed", { error: String(error) }));
      // One-time context-boundary migration for pre-existing Mimi sessions:
      // before range_archive existed, closures trimmed context only in-memory,
      // so every restart re-inflated the prompt to the full transcript. Seed a
      // single persisted marker covering everything before the active segment,
      // summarized from the journal entries we already have — no model call.
      // Idempotent: Engine.appendArchiveMarker dedupes on segmentId, so
      // relaunches and already-migrated sessions no-op. Waits for backfill to
      // settle before taking the journal snapshot, so it never misses the
      // journal entry backfill is about to write for an interrupted segment —
      // context-migration-v1 is a one-time permanent write, so reading too
      // early and missing an entry would not be a benign transient.
      void (async () => {
        // When auto-extract is off, closure only archives — it never writes a
        // journal entry (see the closure service's extraction gate) — so any
        // segment closed while the toggle was off has no summary to represent
        // it here. Migrating anyway would make those segments' messages
        // vanish from the model context with zero representation: a real
        // visibility regression versus today's full-history behavior. Skip
        // and leave today's (uncompacted) exposure as-is until the toggle is
        // back on and a later launch can migrate with full coverage.
        if (!(await autoExtractEnabled())) {
          dlog("main", "pet.contextMigration.skippedAutoExtractOff", { petSessionId });
          return;
        }
        await backfillPromise.catch(() => undefined);
        const activeSegment = petWorkMemory.activeSegment();
        // Ensure the journal is loaded before snapshotting (idempotent/memoized;
        // same pattern as the journal.list() IPC handler above) — otherwise a
        // slow-disk cold start could read an empty list and skip migration for
        // this launch entirely.
        // PetJournalStore.list() is newest-first (sorted by endedAt desc); the
        // migration summary must read oldest→newest, so reverse a copy here.
        const journalEntries = [...(await mimiRecords.journal.list())].reverse();
        if (!activeSegment?.boundaryBeforeMessageId || journalEntries.length === 0) return;
        const summary = buildMigrationSummary(journalEntries);
        if (!summary) return;
        const appended = await petBridge.appendStartupArchiveMarker({
          sessionId: petSessionId,
          summary,
          toClientMessageId: activeSegment.boundaryBeforeMessageId,
          segmentId: "context-migration-v1",
        });
        // false covers two benign cases, not an error: this session was
        // already migrated on a prior launch (idempotent no-op — expected on
        // every subsequent startup), or the anchor was dead (engine already
        // warn-logs that distinctly as engine.archive_marker.dead_anchor).
        // This dlog is just a startup trace, not an alarm.
        if (appended === false) {
          dlog("main", "pet.contextMigration.notAppended", { petSessionId });
        }
      })().catch((error) => dlog("main", "pet.contextMigration.failed", { error: String(error) }));
      // Load/reconcile durable long tasks only after both the session projection
      // and work-memory closure sink are ready. Running tasks left idle by a
      // previous process are marked interrupted and remain resumable.
      await longTaskCoordinator.start();
      notices.router.start();
      // Auto-archive completed work sessions idle for 7+ days, then force a full
      // catalog rebuild. Rationale for the full pass: archiveDiskSession touches
      // state.json → bumps the session's dir mtime → the incremental
      // (mtime high-water) refresh would re-surface it at the front, yet
      // listDiskSessions now default-filters archived rows, so the freshly
      // archived session would be *dropped from the incremental page but never
      // evicted from the held diskSessions Map* — a persistent ghost. A full
      // rebuild repopulates the Map straight from the (archive-filtered)
      // listDiskSessions result, so archived sessions cleanly disappear.
      void runPetAutoArchive(aggregator).catch((error) => {
        dlog("main", "pet.autoArchive.failed", { error: String(error) });
      });
    })();
    disposePetIpc = registerPetIpc({
      ipcMain,
      aggregator,
      dispatcher: petDispatchService,
      attention: notices.attention,
      notices: (petNoticeControls = createPetNoticeControls({
        notices,
        ownerChannels: () => imGatewayService.ownerChannels(),
        goals: externalGoalSessions,
        proactive: () => petProactive.status(),
        writeNotificationSettings: writePetNotificationSettings,
        cancelFollowUp: (followUpId, expectedRevision) =>
          followUpHost({ action: "cancel", followUpId, expectedRevision }),
      })),
      workInbox: petWorkInbox,
      // Read-only topic-segment view for the Mimi chat UI. `segments` carries
      // the message-keyed boundary history (keyed by each segment's first-turn
      // client message id); the renderer skips any boundary whose message id is
      // absent from the current transcript.
      workMemory: {
        getActiveSegmentId: () => petWorkMemory.activeSegment()?.id ?? null,
        getSegments: () => petWorkMemory.segmentBoundaries(),
      },
      longTasks: {
        getSnapshot: () => longTaskStore.getSnapshot(),
        control: (request, signal) => longTaskCoordinator.control(request, signal),
        clearTerminal: (signal) => longTaskCoordinator.clearTerminal(signal),
        clearTask: (taskId, signal) => longTaskCoordinator.clearTerminalTask(taskId, signal),
        subscribe: (listener) => longTaskStore.subscribe(listener),
      },
      memories: mimiRecords.interactive,
      recordAuthority: (event) => desktopHost.documentSignal(event as Electron.IpcMainInvokeEvent),
      recordWindows: () => [...mainWindows].filter((win) => {
        if (win.isDestroyed()) return false;
        try {
          appRendererNavigation.assertSender({ sender: win.webContents, senderFrame: win.webContents.mainFrame });
          return true;
        } catch {
          return false;
        }
      }),
      summaries: {
        collect: (signal) => petFollowUps.collect(undefined, signal),
        control: (request, signal) => followUpHost({ ...request }, undefined, signal),
        subscribe: followUpRuntime.subscribe,
      },
      journal: {
        ...mimiRecords.journal,
        readSegmentMessages: async (range) =>
          petSegmentClosureService ? petSegmentClosureService.readSegmentMessages(range) : [],
      },
      preferences: {
        getAutoExtract: async () =>
          petMemoryAutoExtractFromSettings(await readSettings("user").catch(() => null)),
        setAutoExtract: async (enabled) => {
          await desktopHost.callBusiness("settings/patch", {
            scope: "user",
            patch: petMemoryAutoExtractSettingsPatch(enabled),
          });
          return enabled;
        },
      },
      sessionArchive: {
        archive: async (sessionId) => {
          // By-id archive must not be limited to a page of recent sessions.
          const sessions = await listAllDiskSessions();
          const session = sessions.find(
            (candidate) =>
              candidate.engineSessionId === sessionId && candidate.origin === "desktop",
          );
          if (!session) throw new Error("Session 不存在或不允许归档");
          if (session.archivedAt === undefined) {
            await archiveDiskSession(session.engineSessionId, Date.now());
            await aggregator.refreshCatalog(true, { full: true });
          }
          return { ok: true };
        },
      },
      hostActionReceipt: hostActionReceiptService,
      windows: () => BrowserWindow.getAllWindows(),
      ready: petInitialization,
    });
    const disposePetIpcRoutes = disposePetIpc;
    disposePetIpc = () => {
      mimiNoticeTools.dispose();
      disposePetIpcRoutes();
    };
    // The renderer immediately publishes its active session and reads Mimi's
    // state. Register those handlers before loading it; handlers themselves
    // await hydration, so the interface can still load while indexes recover.
    loadRenderer();
    await petInitialization;
    petRuntimeReady = petDispatchService !== null;
    markPetIpcReady?.();
    markPetIpcReady = null;
  } else {
    bridge.attachWindow(win);
    loadRenderer();
  }

  await installAppMenu(win, projectStore);
  return win;
}

/** Days of inactivity after which a completed work session is auto-archived. */
const PET_AUTO_ARCHIVE_IDLE_DAYS = 7;

/**
 * One-shot auto-archival pass, run right after pet init. Pulls the full catalog
 * (including already-archived rows so the policy can skip them), selects the
 * completed sessions idle for 7+ days, writes their archival markers, and — if
 * anything changed — forces a FULL catalog rebuild so the aggregator's held Map
 * is repopulated from the archive-filtered listDiskSessions (no ghost rows).
 */
async function runPetAutoArchive(aggregator: typeof desktopHost.mimiProjection): Promise<void> {
  const sessions = await listAllDiskSessions();
  const toArchive = selectSessionsToArchive(
    sessions.map((s) => ({
      engineSessionId: s.engineSessionId,
      status: s.status,
      updatedAt: s.updatedAt,
      archivedAt: s.archivedAt,
    })),
    { now: Date.now(), idleDays: PET_AUTO_ARCHIVE_IDLE_DAYS },
  );
  if (toArchive.length === 0) return;
  const now = Date.now();
  for (const id of toArchive) {
    await archiveDiskSession(id, now).catch((error) => {
      dlog("main", "pet.autoArchive.write.failed", { id, error: String(error) });
    });
  }
  // Full rebuild: archived sessions must be evicted from the held Map, not just
  // absent from an incremental page (see the trigger comment in the pet init).
  await aggregator.refreshCatalog(true, { full: true });
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

function cleanupKnownAttachments(sessionId?: string): Promise<void> {
  return desktopHost.callBusiness("startup/cleanupAttachments", {sessionId});
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

async function dispatchGatewayPetChat(
  request: PetChatControlRequest,
): Promise<PetChatControlResult> {
  const dispatcher = petDispatchService;
  if (!dispatcher) throw new Error("Mimi Pet 尚未就绪，请稍后重试");
  const sessionId = await dispatcher.getSessionId();
  // A reply to an open item (a decision prompt, a goal pause, a result) is read
  // against those items first, before Mimi, a Session binding or the chat
  // scheduler can take it as a new task or as inferred authorization.
  const decisionReply = await petImDecisions?.reply(request);
  if (typeof decisionReply === "string") return { text: decisionReply, petSessionId: sessionId };
  // "交给 Mimi": Mimi's turn gets the notice's data with the owner's request;
  // the item is used once that turn is dispatched, and freed if it never is.
  try {
    const attachments = await stageGatewayAttachments(request, sessionId);
    const replay = petNotices?.inboundReplay(request.origin);
    const publish = (
      event: Extract<PetChatEvent, { kind: "user-submitted" | "host-action-completed" }>,
    ) => {
      for (const win of BrowserWindow.getAllWindows())
        if (!win.isDestroyed()) win.webContents.send(PET_CHAT_EVENT_CHANNEL, event);
    };
    try {
      return await desktopHost.mimiDispatch.gatewayTurn(
        {
          sessionId,
          message: request.message,
          origin: request.origin,
          handoff: decisionReply?.handoff,
          attachments,
        },
        {
          submitted: publish,
          completed: publish,
          dispatched: () => {
            replay?.finish();
            void decisionReply?.dispatched();
          },
          attachmentsSent: () => markAttachmentsSent(resolveNoRepoCwd(), sessionId, attachments),
        },
        replay,
      );
    } finally {
      replay?.finish();
    }
  } finally {
    decisionReply?.abandoned();
  }
}

async function stageGatewayAttachments(request: PetChatControlRequest, sessionId: string) {
  const cwd = resolveNoRepoCwd();
  const attachments: InputAttachmentMeta[] = [];
  let totalBytes = 0;
  for (const input of request.attachments ?? []) {
    const bytes = decodeGatewayAttachment(input.dataBase64, input.size);
    totalBytes += bytes.byteLength;
    if (bytes.byteLength > 10 * 1024 * 1024 || totalBytes > 20 * 1024 * 1024) {
      throw new Error("IM 附件超过大小限制");
    }
    if (input.kind === "image") {
      attachments.push(
        await stageImageBytes({
          cwd,
          sessionId,
          name: input.name,
          mime: input.mimeType ?? "application/octet-stream",
          bytes,
          origin: "im-gateway",
        }),
      );
    } else {
      attachments.push(
        await stageFileBytes({
          cwd,
          sessionId,
          name: input.name,
          mime: input.mimeType,
          bytes,
          origin: "im-gateway",
        }),
      );
    }
  }

  return attachments;
}

function decodeGatewayAttachment(dataBase64: string, expectedSize: number): Buffer {
  if (
    dataBase64.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(dataBase64) ||
    dataBase64.length > 28 * 1024 * 1024
  ) {
    throw new Error("IM 附件不是有效的 base64 数据");
  }
  const bytes = Buffer.from(dataBase64, "base64");
  if (bytes.byteLength !== expectedSize) throw new Error("IM 附件大小校验失败");
  return bytes;
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
    outcome: (result) => { void petNotices?.outboxResult(result); },
    ready: () => { void petNotices?.outboxReady(); },
    open: () => startMobileRemote({ mode: "tunnel" }),
    close: () => stopMobileRemote(),
    status: () => getMobileRemoteGatewayStatus(),
    pairingUrl: () => createMobileRemotePairingUrl(),
    petChat: (request) => dispatchGatewayPetChat(request),
    isPetChatReady: () => petRuntimeReady && petDispatchService !== null,
    isSessionRouteReady: () =>
      petRuntimeReady && petDispatchService !== null && sessionBridge !== undefined,
    routeSession: sessionRouteHandler({
      bridge: () => sessionBridge,
      replyToSession: async (request) => petImDecisions?.replyToSession(request),
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
    await petRuleScheduler?.start();

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
  if (change.pet) petNotices?.settingsChanged();
  if (change.externalVisibility) await reconcileExternalAdapters?.();
  if (change.panelApps) broadcastPanelAppsChanged(mainWindows);
  if (change.pluginCommands) broadcastPluginCommandsChanged(mainWindows);
}

registerMemoryIpc({ mainWindows, host: desktopHost });
const sessionDeletions = new Map<string, Promise<void>>();
function deleteDesktopSession(id: string): Promise<void> {
  const existing = sessionDeletions.get(id);
  if (existing) return existing;
  deletingBrowserSessions.add(id);
  desktopHost.setStreamView(id, false);
  desktopHost.setDeleting(id, true);
  rendererBrowserSessionAccess.forgetSession(id);
  const pending = Promise.resolve()
    .then(() => deleteDesktopSessionResources(id))
    .finally(() => {
      // Invalidate any authorization captured before deletion started, including
      // in-flight durable reads, before allowing this ID to be opened again.
      rendererBrowserSessionAccess.forgetSession(id);
      deletingBrowserSessions.delete(id);
      desktopHost.setDeleting(id, false);
      sessionDeletions.delete(id);
    });
  sessionDeletions.set(id, pending);
  return pending;
}

async function deleteDesktopSessionResources(id: string): Promise<void> {
  mediaPreviewService.releaseSession(id);
  builtInBrowserHandoffGrants.clearSession(id);
  panelAccessRequests.forgetSession(id);
  chromeExtensionRuntimeService.forgetSession(id);
  const browserPartition = partitionForSession(id);
  const ephemeralBrowserPartition = id.startsWith("qchat-") ? browserPartition : null;
  if (browserPartition && isBrowserPartition(browserPartition)) {
    cookieCredentialAutoRefresh.unbind(session.fromPartition(browserPartition));
  }
  // Reap the session's background shells (if any) before dropping it —
  // explicit delete is the one tab-close path that DOES kill (core §6).
  await bridge?.closeSession(id);
  // An external runtime is a child process plus a listening port; neither is
  // owned by the worker, so closeSession above does not touch them. Without
  // this a deleted session leaves both alive for the rest of the app's life.
  await externalRuntime.service?.stop(id).catch((error) => {
    dlog("external-runtime", "session.delete.stop_failed", { id, error: String(error) });
  });
  // The external binding is a file inside the Session directory.
  await desktopHost.callBusiness("sessions/deleteFiles", { sessionId: id });
  await taskInboxService.sessionIntent({ type: "sessionDeleted", sessionId: id });
  await cleanupKnownAttachments(id);
  // Drop any in-memory snapshot for the deleted session so it can't be
  // replayed into a fresh tab that happens to reuse the id.
  await bridge?.forgetSession(id);
  if (ephemeralBrowserPartition?.startsWith("browser:qchat:")) {
    const ephemeralSession = session.fromPartition(ephemeralBrowserPartition);
    await Promise.all([ephemeralSession.clearStorageData(), ephemeralSession.clearCache()]).catch(
      (error) => {
        dlog("browser", "quick_chat.partition_cleanup_failed", {
          id,
          partition: ephemeralBrowserPartition,
          error: String(error),
        });
      },
    );
  }
}


ipcMain.handle("sessions:delete", async (_e, id: string) => {
  assertDesktopSessionId(id);
  await deleteDesktopSession(id);
});
function assertQuickChatClaim(id: unknown, claimId: unknown): asserts id is string {
  if (typeof id !== "string" || !/^qchat-[A-Za-z0-9.-]+$/.test(id)) {
    throw new Error("quick-chat session id required");
  }
  if (typeof claimId !== "string" || !/^[A-Za-z0-9.-]{1,128}$/.test(claimId)) {
    throw new Error("quick-chat claim id required");
  }
}

ipcMain.handle("quickChat:claimSession", async (event, id: unknown, claimId: unknown) => {
  assertQuickChatClaim(id, claimId);
  const ownerId = event.sender.id;
  quickChatOwnership.claim(id, ownerId, claimId as string);
  if (!quickChatOwnerCleanupRegistered.has(ownerId)) {
    quickChatOwnerCleanupRegistered.add(ownerId);
    event.sender.once("destroyed", () => {
      quickChatOwnerCleanupRegistered.delete(ownerId);
      void quickChatOwnership
        .releaseOwner(ownerId, deleteDesktopSession)
        .catch((error) =>
          dlog("main", "quick_chat.owner_cleanup_failed", { ownerId, error: String(error) }),
        );
    });
  }
});
ipcMain.handle("quickChat:isClaimActive", async (event, id: unknown, claimId: unknown) => {
  assertQuickChatClaim(id, claimId);
  return quickChatOwnership.isClaimActive(id, event.sender.id, claimId as string);
});
ipcMain.handle("quickChat:cleanupSession", async (event, id: unknown, claimId: unknown) => {
  assertQuickChatClaim(id, claimId);
  return quickChatOwnership.cleanup(id, event.sender.id, claimId as string, () =>
    deleteDesktopSession(id),
  );
});

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
  if (!petDispatchService || sessionId !== (await petDispatchService.getSessionId()))
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
    sessionProjection: () => petStateAggregator?.getSnapshot(), sessionCatalogStore,
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
    petRuntimeReady = false;
    browserRuntime.closeAll();
    bridge?.kill();
  },
  stopMimi() {
    petStateAggregator?.stop();
    petStateAggregator = null;
    reconcileExternalAdapters = null;
    petDispatchService = null;
    petRuleScheduler?.stop();
    petRuleScheduler = null;
    petHostActionReceiptService = null;
    petImDecisions?.stop();
    petImDecisions = null;
    unsubscribePetLongTaskStream?.();
    unsubscribePetLongTaskStream = null;
    unsubscribePetReportStream?.();
    unsubscribePetReportStream = null;
    const petNoticeFlush = petNotices?.flush();
    petNotices?.dispose();
    petNotices = null;
    const petWorkInboxFlush = petWorkInboxStore?.flush();
    petWorkInboxStore = null;

    disposePetIpc?.();
    disposePetIpc = null;
    return [petNoticeFlush, petWorkInboxFlush];
  },
  history: () => closeActivityHistory?.(),
  mimiShell,
  mobileShell,
  panelAppBridge,
  finalize: () => sessionCatalogIpc.close(),
});
