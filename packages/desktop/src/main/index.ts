import { registerLinkedFileSourceIpc } from "./linked-file-sources-ipc.js";
import { openLinkedFileSourceOperation } from "./linked-file-sources-host.js";
import { registerOperationBatchHost } from "./operation-batch-host.js";
import { createDesktopRemoteServices } from "./desktop-remote-services.js";
import { createDesktopModuleRegistry, registerDesktopShutdown } from "./desktop-shutdown.js";
import { createExternalRuntimeModule } from "./external-runtime-module.js";
import { externalRuntimeMimiHost } from "./external-runtime-mimi-tools.js";
import { registerProjectPanelIpc } from "./project-panel-ipc.js";
import { registerProfileSwitchIpc } from "./profile-switch-ipc.js";
import { registerSourceCollectionIpc } from "./source-collections-ipc.js";
import { openSourceCollectionOperation } from "./source-collections-host.js";
import { registerRemoteLinkIpc } from "./remote-link-ipc.js";
import { linkAccountExecutionOptions, requireLinkAccountAccess } from "./link-account-access.js";
import { registerOperationResolutionHost } from "./operation-resolution-host.js";
/**
 * Electron main entry — broker between renderer (ipcMain) and the
 * agent worker subprocess (stdio JSON-RPC). See agent-bridge.ts.
 */

import {
  app,
  BrowserWindow,
  WebContentsView,
  dialog,
  ipcMain,
  Menu,
  session,
  shell,
  safeStorage,
  Notification,
  screen,
  nativeTheme,
  powerMonitor,
} from "electron";
import { mainWindowTitleBarOptions, registerWindowTitleBarIpc } from "./window-titlebar.js";
import {
  openCloudWorkbench,
  openManagedCloudWorkbench,
  closeManagedCloudWorkbench,
} from "./cloud-workbench-window.js";
import { registerCloudEnvironmentIpc } from "./cloud-environment-ipc.js";
import { injectDesktopManagedRuntimePath } from "./managed-runtime-service.js";
import { createDesktopManagedRuntimeWiring } from "./managed-runtime-wiring.js";
import { fileURLToPath, pathToFileURL } from "node:url";
import { AppRendererNavigation } from "./app-renderer-navigation.js";
import { randomUUID } from "node:crypto";
import { dirname, resolve, isAbsolute, join } from "node:path";
import {
  approvePluginHooks,
  approvePluginMcp,
  listPluginMcpTrust,
  listPluginHooks,
  revokePluginMcp,
  revokePluginHooks,
  SettingsManager,
  SessionManager,
  writeSettingsSchemaFile,
  userHome,
  codeShellHome,
  CredentialStore,
  summarizeCookieExpiry,
  materializeCookieSecret,
  sweepStaleCredentialCookies,
  setDefaultCredentialCipher,
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
  startAutomation,
  CronStore,
  defaultCronStorePath,
  agentNotificationBus,
  type AutomationHandle,
  getMergedCatalog,
  setGitPathOverride,
  isGitAvailable,
  resolveGitPath,
  describeTranscribe,
} from "@cjhyy/code-shell-core/internal";
import {
  CC_COST_GUARD_PROMPT,
  discoverRecentClaudeSessions,
  discoverRecentCodexSessions,
  parseClaudeTranscriptLine,
  parseCodexTranscriptLine,
  type ExternalSessionDiscoveryScope,
} from "@cjhyy/code-shell-capability-coding/orchestration";
import { AgentBridge, resolveNoRepoCwd } from "./agent-bridge.js";
import { getCuaDriverHost } from "./computer-use/service.js";
import {
  initializeDesktopComputerUse,
  closeComputerUse,
  getComputerUseInputControl,
  getMimiCompanion,
  mimiMovingUnavailableReason,
} from "./computer-use/desktop-setup.js";
import { startMobileExternalRuntime } from "./mobile-remote/start-external-runtime.js";
import { initializeMobileRemoteLifecycle } from "./mobile-remote/lifecycle.js";
import { resolveMobileStaticRoot } from "./mobile-remote/mobile-static-root.js";
import {
  externalRuntimeToolContextForSession,
  externalRuntimeWorkspaceForSession,
} from "./external-runtime-tool-context.js";
import { createExternalRuntimeBackgroundWork } from "./external-runtime-background-work.js";
import { createExternalGoalRpcHandler } from "./external-runtime-goal-rpc.js";
import { buildExternalRuntimeHandoffFromEvents } from "./external-runtime-handoff.js";
import {
  removeExternalRuntimeBinding,
  readExternalRuntimeBinding,
} from "./external-runtime-state.js";
import { parseExternalRuntimeModelKey } from "../shared/external-runtime-models.js";
import {
  requireRendererProject,
  requireRendererProjectPath,
  requireRendererProjectPrimary,
  requireRendererProjectRoot,
} from "./renderer-project-path.js";
import { PetStateAggregator } from "./pet/pet-state-aggregator.js";
import { ExternalSessionAdapter, type ExternalCli } from "./pet/external-session-adapter.js";
import {
  ExternalSessionVisibilityController,
  touchesExternalSessionVisibility,
} from "./pet/external-session-visibility.js";
import { createLatestResultCache } from "./pet/latest-result-cache.js";
import { createPetSummaryStore } from "./pet/pet-summary-store.js";
import { createPetSummaryService } from "./pet/pet-summary-service.js";
import { PetJournalStore } from "./pet/pet-journal-store.js";
import {
  createPetSegmentClosureService,
  type PetSegmentClosureService,
} from "./pet/pet-segment-closure-service.js";
import {
  broadcastPetChatTranscriptUpdated,
  PET_CHAT_EVENT_CHANNEL,
  registerPetIpc,
} from "./pet/pet-ipc.js";
import {
  completePetHostActionReceipt,
  PetHostActionReceiptService,
} from "./pet/pet-host-action-completion.js";
import { PetMetadataStore } from "./pet/pet-metadata-store.js";
import { PetDispatchService, type PetHostActionExecution } from "./pet/pet-dispatch-service.js";
import { enrichPetChatReplyWithHostActions } from "./pet/host-action-reply.js";
import { PetMemoryStore } from "./pet/pet-memory-store.js";
import { petWidgetMenuTemplate } from "./pet/pet-widget-menu.js";
import { createPetMemoryHost, createPetMemoryWorldContext } from "./pet/pet-memory-host.js";
import { PetWorkDelegationHost } from "./pet/pet-work-delegation-host.js";
import { PetChatAttachmentContext } from "./pet/pet-chat-attachment-context.js";
import { getSessionCwdIndex } from "./session-cwd-index.js";
import { wirePetNotices, type PetNoticeWiring } from "./pet/pet-notice-wiring.js";
import { withExternalDecisions } from "./pet/pet-notice-external-decisions.js";
import { createExternalSessionCatalog } from "./pet/pet-notice-external-sessions.js";
import { createPetNoticeControls } from "./pet/pet-notice-ipc.js";
import { PetWorkInboxStore } from "./pet/pet-work-inbox-store.js";
import { PetHostActionReceiptStore } from "./pet/pet-host-action-receipts.js";
import { archivePetSessionsBySelector } from "./pet/pet-session-archive.js";
import { createPetFollowUpRules } from "./pet/pet-follow-up-rules.js";
import { wirePetProactive } from "./pet/pet-proactive-wiring.js";
import { PetRuleScheduler, isPetRuleScheduleJob } from "./pet/pet-rule-schedule.js";
import { PetContextLinkStore } from "./pet/pet-context-links.js";
import { PetWorkMemoryStore } from "./pet/pet-work-memory-store.js";
import { PetSegmentController, type PetArchiveAnchors } from "./pet/pet-segment-controller.js";
import { recordPetDelegationClosureBestEffort } from "./pet/pet-delegation-closure.js";
import { PetReportReceiptStore } from "./pet/pet-report-receipt-store.js";
import { PetLongTaskStore } from "./pet/pet-long-task-store.js";
import { PetLongTaskCoordinator } from "./pet/pet-long-task-coordinator.js";
import {
  createSessionOutcomeFanout,
  createSessionOutcomeTap,
  feedSessionOutcomeTap,
  SessionOutcomeDeriver,
} from "./pet/session-outcome.js";
import {
  PetImDecisions,
  collectImDecisions,
  imDecisionWorkerActions,
} from "./pet/pet-im-decisions.js";
import { createOwnerReplyHandling, lastUserMessageIn } from "./pet/pet-notice-action-controls.js";
import { selectSessionsToArchive } from "./pet/pet-auto-archive.js";
import { resolveLinkedSessionFromDisk } from "./cc-room/linked-session-resolver.js";
import { DEFAULT_SEGMENT_IDLE_MS, buildMigrationSummary } from "@cjhyy/code-shell-pet";
import { searchSessionTranscripts } from "@cjhyy/code-shell-pet/disclosure";
import { materializeOutgoingAttachments } from "@cjhyy/code-shell-chat";
import { createReusableSessionResolver } from "./pet/reusable-session-resolver.js";
import {
  createBoundSessionHealth,
  createBoundSessionRunner,
  createSessionBridgeWiring,
  sessionRouteHandler,
  type SessionBridgeWiring,
} from "./pet/session-bridge-wiring.js";
import {
  petChatModelKeyFromSettings,
  petMemoryAutoExtractFromSettings,
  petMemoryAutoExtractSettingsPatch,
  petPersonalizationFromSettings,
} from "../shared/pet-settings.js";
import { installedThemeToPack } from "./theme-pack-conversion.js";
import { themeImportDialogOptions } from "./theme-import-dialog.js";
import { SafeStorageCipher } from "./credential-cipher.js";
import { createDesktopModelRequestSigner } from "./model-request-signing-service.js";
import { McpOAuthService, type McpOAuthLoginInput } from "./mcp-oauth-service.js";
import { LinkDeviceOAuthBroker } from "./link-device-oauth.js";
import { type ManagedCliInstallResult } from "./link-cli-installer.js";
import { migrateCredentialStore, migrateKnownCredentialStores } from "./credential-migration.js";
import { inspectReadableReplyAttachment } from "./image-read-service.js";
import { MediaPreviewService } from "./media-preview-service.js";
import { browserPartitionForBucket } from "./renderer-browser-session-ipc-authority.js";
import { resolveMediaPreviewAuthority } from "./media-preview-authority.js";
import { MEDIA_PREVIEW_SCHEME } from "../shared/media-preview.js";
import {
  guestRecordForId,
  partitionForSession,
  rememberAttachedGuest,
} from "./browser-driver/active-guest.js";
import {
  browserRuntime,
  builtInBrowserHandoffGrants,
  chromeExtensionRuntimeService,
  installChromeNativeMessagingHost,
  interactiveBrowserBridgeForSession,
  nativeMessagingOriginFromArgv,
  panelAccessRequests,
  runChromeNativeMessagingHost,
  type ChromeNativeRegistrationResult,
} from "./browser-runtime/index.js";
import {
  buildDesktopAutomationRunner,
  makeCronRunnerWithResume,
  resolveDesktopAutomationJobWorkspace,
} from "./automation-host.js";
import { createAutomationResumeTurn } from "./automation-resume-turn.js";
import { automationLifecycleNotification } from "./automation-notification.js";
import { DesktopNotifier } from "./desktop-notifier.js";
import {
  findNotificationWindow,
  showNativeDesktopNotification,
} from "./native-desktop-notification.js";
import * as desktopNotifications from "./desktop-notification-routes.js";
import {
  setAutomationScheduler,
  listAutomations,
  getAutomation,
  createAutomation,
  updateAutomation,
  listAutomationsForResumeSession,
  deleteAutomation,
  pauseAutomation,
  resumeAutomation,
  runAutomationNow,
  cancelAutomationRun,
  type CreateAutomationInput,
} from "./automation-service.js";
import { desktopAutomationAuthorityDeps } from "./automation-authority.js";
import { dlog } from "./desktop-logger.js";
import { ptyKillAll, ptyReapDestroyed } from "./pty-service.js";
import { cleanupLease, sweepStaleLeases, BROWSER_PARTITION } from "./credentials-service.js";
import { cookieCredentialAutoRefresh } from "./cookie-credential-auto-refresh.js";
import { isBrowserPartition } from "../shared/browser-partition.js";
import { isProfileBrowserPartition } from "../shared/browser-profile.js";
import { resolveCookieCredentialForBrowser } from "./credential-action.js";
import { restoreCookieCredentialToBrowser } from "./cookie-credential-browser.js";
import { loginAndCaptureCookies } from "./credentials-login/index.js";
import {
  archiveDiskSession,
  cleanupAttachments,
  cleanupSessionAttachments,
  cleanupStaleQuickChatSessions,
  deleteSession,
  listDiskSessions,
  markAttachmentsSent,
  stablePromptHash,
  stageFileBytes,
  stageImageBytes,
  type InputAttachmentMeta,
} from "@cjhyy/code-shell-server/storage";
import {
  AccessPasscode,
  CloudflaredBinary,
  CodexRoomAgent,
  MobileUploadService,
  PendingMobileApprovals,
  RemoteHostManager,
  ResidentAgentProcess,
  RoomManager,
  TrustedDeviceStore,
  TunnelManager,
} from "@cjhyy/code-shell-server/mobile-remote";
import {
  MobileRemoteOrchestrator,
  type AuthenticatedMobileClientEvent,
} from "./mobile-remote-orchestrator.js";
import { createDesktopRoomModeAuthority } from "./cc-room/room-mode-ipc.js";
import {
  GatewayControlServer,
  type GatewayControlEventAttachment,
  type GatewayControlEvent,
  type GatewayControlEventInput,
  type PetChatControlRequest,
  type PetChatControlResult,
} from "./im-gateway-control-server.js";
import { ImGatewayService, registerImGatewayIpc } from "./im-gateway-service.js";
import { ApprovalBridge } from "./cc-room/approval-bridge.js";
import { createRoomTranscriptSubscriptions } from "./cc-room/transcript-subscriptions.js";
import { QuickChatOwnershipRegistry } from "./quick-chat-ownership.js";
import { getGitStatus, getGitBranches, revealInFinder, openPath } from "./desktop-services.js";
import { readSettings, writeSettings, type SettingsScope } from "./settings-service.js";
import { registerDesktopOutputHistoryHost } from "./session-output-history-host.js";
import { registerSessionCatalogIpc } from "./session-catalog-ipc.js";
import { SessionCatalogStore } from "./session-catalog-store.js";
import { createTaskInboxSources } from "./task-inbox/task-inbox-sources.js";
import { createTaskInboxService } from "./task-inbox/task-inbox-service.js";
import { createTaskInboxBackgroundHost } from "./task-inbox/task-inbox-background-host.js";
import * as backgroundWork from "./cc-room/background-work-ipc.js";
import { registerTaskInboxIpc } from "./task-inbox/task-inbox-ipc.js";
import { registerOptimizationLabHost } from "./optimization-lab-host.js";
import { taskInboxPetView } from "./task-inbox/task-inbox-pet-view.js";
import { assertDesktopSessionId } from "./session-validation.js";
import { getSessionEvents } from "./rawTranscript.js";
import { createLinkService } from "@cjhyy/code-shell-server/links";
import { createDesktopWebService, deploymentRemoteLink } from "./desktop-web-service.js";
import { createDesktopPanelAutomationHost } from "./panel-automation-host.js";
import { listSkills, readSkillBody, uninstallSkill } from "./skills-service.js";
import {
  listPlugins,
  getPluginDetail,
  uninstallPluginEntry,
  uninstallLocalPluginEntry,
  updatePluginEntry,
  checkPluginUpdateEntry,
} from "./plugins-service.js";
import { invalidatePanelAppBindingGuard, isPanelAppBoundToProject } from "./panel-apps-service.js";
import { createAutomationFromPluginTemplate } from "./plugin-automation-service.js";
import { expandPluginCommand, listPluginCommands } from "./plugin-command-service.js";
import { getPluginMedia } from "./plugin-media-service.js";
import {
  preparedPanelAppPartitionProjectPath,
  preparePanelApp,
  registerPanelAppSchemePrivileges,
  validatePanelAppEntryUrl,
} from "./panel-app-protocol.js";
import { installThemeAssetProtocol, THEME_ASSET_SCHEME } from "./theme-asset-protocol.js";
import { PanelAppBridge } from "./panel-app-bridge.js";
import { PanelAppWindows } from "./panel-app-windows.js";
import { buildPanelAgentTaskModelCatalog } from "./panel-app-agent-task-models.js";
import {
  listMarketplacesForUi,
  loadMarketplaceForUi,
  addMarketplaceFromInput,
  addRecommendedMarketplaceForUi,
  listPluginInstallJobsForUi,
  listRecommendedMarketplacesForUi,
  removeMarketplaceForUi,
  refreshMarketplaceForUi,
  installPluginForUi,
  installLocalPluginForUi,
  previewLocalPluginForUi,
  onPluginInstallJobsChanged,
  retryPluginInstallJobForUi,
  gitDownloadUrl,
  gitInstallGuidance,
} from "./marketplace-service.js";
import {
  listCapabilities,
  setCapabilityEnabled,
  setCapabilityOverride,
} from "./capabilities-service.js";
import {
  bind as bindSource,
  catalogDelete as deleteSourceCatalog,
  catalogList as listSourceCatalog,
  catalogSave as saveSourceCatalog,
  deleteUpload,
  listScopes as listSourceScopes,
  unbind as unbindSource,
  uploadFiles,
  workspaceAccess as workspaceSourceAccess,
} from "./sources-service.js";
import { createRendererProjectFileSearch } from "./file-search-service.js";
import { checkSkillUpdateEntry, updateSkillEntry } from "./skill-update-entry.js";
import { listRuns } from "./runs-service.js";
import {
  initUpdater,
  checkForUpdate,
  downloadUpdate,
  quitAndInstall,
  cancelPendingUpdateInstall,
  getLastStatus,
} from "./updater.js";
import { loadProjects } from "./recents-store.js";
import { getProjectStore } from "./project-store.js";
import {
  createDesktopPanelProjectScopeResolver,
  isRegisteredPanelProjectRoot,
  resolveDesktopPanelProjectPath,
} from "./panel-project-scope.js";
import { registerProjectAuthorityIpc } from "./project-authority-ipc.js";
import { loadWindowState, saveWindowState } from "./window-state-store.js";
import {
  petWidgetWindowStatePath,
  shouldSkipPetWidgetTaskbar,
} from "./pet/pet-widget-window-state.js";
import { createPetWidgetSurface, type PetWidgetSurface } from "./pet/pet-widget-surface.js";
import { createMimiBubbleHost, type MimiBubbleHost } from "./pet/mimi-bubble-host.js";
import { MimiPresenceController } from "./pet/mimi-presence-controller.js";
import {
  createMimiPresenceWriter,
  defaultMimiPresenceState,
  loadMimiPresenceState,
  MIMI_PRESENCE_FILE,
  type MimiPresenceLoadResult,
} from "./pet/mimi-presence-state.js";
import {
  effectiveMimiVisible,
  legacyCompanionSettings,
  registerMimiPresenceIpc,
  type MimiPresenceOwner,
} from "./pet/mimi-presence-ipc.js";
import type { MimiPresenceSnapshot } from "../shared/mimi-presence.js";
import { getTrust, getTrustCachedSync, warmTrustCache } from "./trust-store.js";
import { installAppMenu } from "./menu.js";
import { seedDefaults } from "./seed-defaults.js";
import { bootstrapCorePlugins } from "./bootstrap-core-plugins.js";
import { invalidateMcpProbeCache } from "./mcp-probe-service.js";
import { injectLoginShellPathAtStartup } from "./login-shell-path.js";
import {
  acquireDesktopInstanceLock,
  registerSecondInstanceFocus,
  createMainWindowRestorer,
  runOwnedQuickChatStartupCleanup,
} from "./quick-chat-startup-cleanup.js";
import {
  resolveRendererConfigurationTarget,
  type RendererConfigurationTarget,
} from "./renderer-configuration-authority.js";
import {
  rendererConfigurationCwd,
  rendererOptionalConfigurationCwd,
  rejectUnexpectedRendererKeys,
  requireRendererListedSkillPath,
} from "./renderer-configuration-helpers.js";
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
import { registerMobileRemoteIpc } from "./mobile-remote-ipc.js";
import { registerRoomsIpc } from "./rooms-ipc.js";
import { registerDialogPickerIpc } from "./dialog-picker-ipc.js";
import { registerExternalRuntimeIpc } from "./external-runtime-ipc.js";
import { registerBrowserPopoutIpc } from "./browser-popout-ipc.js";
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
const chromeNativeMessagingOrigin = nativeMessagingOriginFromArgv(process.argv);
if (chromeNativeMessagingOrigin) {
  void runChromeNativeMessagingHost(chromeNativeMessagingOrigin)
    .then(() => app.exit(0))
    .catch((error) => {
      process.stderr.write(`[codeshell chrome native host] ${String(error)}\n`);
      app.exit(1);
    });
}

// Electron accepts privileged custom schemes in one pre-ready registration.
// The request handlers are installed later on their respective sessions.
registerPanelAppSchemePrivileges();

// Override the runtime app name. In dev (`electron .`) the default is
// "Electron"; this makes the macOS menu bar, Dock tooltip, and About
// panel show our product name even before packaging. setAppUserModelId
// makes Windows taskbar/notification grouping work correctly.
app.setName("code-shell");
if (process.platform === "win32") app.setAppUserModelId("com.cjhyy.codeshell");
const mainWindows = new Set<BrowserWindow>();
const mediaPreviewService = new MediaPreviewService({
  isOwnerAlive: (ownerId) =>
    [...mainWindows].some(
      (window) =>
        !window.isDestroyed() &&
        !window.webContents.isDestroyed() &&
        window.webContents.id === ownerId,
    ),
  resolveAuthority: async (sessionId, ownerId) => {
    const sessionOwner = bridge?.panelOwnerWebContentsId(sessionId);
    if (sessionOwner !== undefined && sessionOwner !== ownerId)
      throw new Error("Media task belongs to another window");
    return resolveMediaPreviewAuthority(sessionId);
  },
});
/** Deliver to the one live window owning `webContentsId`; other windows never see it. */
function sendToOwnerWindow(webContentsId: number | undefined, channel: string, payload: unknown) {
  [...mainWindows]
    .find((window) => !window.isDestroyed() && window.webContents.id === webContentsId)
    ?.webContents.send(channel, payload);
}
/** Docked Mimi (the pet widget). Created once the app is ready. */
let petWidgetSurface: PetWidgetSurface | null = null;
/** Moving Mimi's chat and work list: the docked widget's panels, opened beside her. */
let mimiBubble: MimiBubbleHost | null = null;
/** The single owner of Mimi's desktop presence (docked/moving, never both). */
let mimiPresence: MimiPresenceController | null = null;
let resolveMimiPresence: ((controller: MimiPresenceController) => void) | null = null;
const mimiPresenceReady = new Promise<MimiPresenceController>((resolveReady) => {
  resolveMimiPresence = resolveReady;
});
const initialMimiPresenceSnapshot: MimiPresenceSnapshot = {
  visible: false,
  mode: "docked",
  size: defaultMimiPresenceState().size,
  appearance: defaultMimiPresenceState().appearance,
  effectiveMode: "docked",
  shown: null,
  movingAvailable: false,
  movingUnavailableReason: "正在初始化",
  previewing: false,
};
/** Requests made before startup finishes wait for the owner instead of failing. */
const mimiPresenceOwner: MimiPresenceOwner = {
  snapshot: () => mimiPresence?.snapshot() ?? initialMimiPresenceSnapshot,
  set: async (patch) => (await mimiPresenceReady).set(patch),
  preview: async () => (await mimiPresenceReady).preview(),
  retry: async () => (await mimiPresenceReady).retry(),
};
const petWidgetWindow = (): BrowserWindow | null =>
  (petWidgetSurface?.window() as BrowserWindow | null | undefined) ?? null;
/** Mimi windows besides the main ones that render pet chat and history. */
const petSurfaceWindows = (): BrowserWindow[] =>
  [petWidgetWindow(), mimiBubble?.surface.window() as BrowserWindow | null | undefined].filter(
    (win): win is BrowserWindow => !!win,
  );
let markPetIpcReady: (() => void) | null = null;
const petIpcReady = new Promise<void>((resolveReady) => {
  markPetIpcReady = resolveReady;
});
const ownsDesktopInstance = chromeNativeMessagingOrigin ? false : acquireDesktopInstanceLock(app);
const restoreMainWindow = createMainWindowRestorer(preferredMainWindow, async () => {
  await app.whenReady();
  return createWindow();
});
if (ownsDesktopInstance) {
  registerSecondInstanceFocus(
    (handler) => app.on("second-instance", handler),
    () => Array.from(mainWindows),
    () => {
      void restoreMainWindow().catch((error) =>
        dlog("main", "window.restore_failed", { error: String(error) }),
      );
    },
  );
}

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
let chromeNativeRegistration: ChromeNativeRegistrationResult | undefined;
const externalRuntime = createExternalRuntimeModule(() => {
  const externalBridge = bridge!;
  return {
    approvals: {
      windows: () => mainWindows,
      ownerWebContentsId: (sessionId) => externalBridge.panelOwnerWebContentsId(sessionId),
      onPendingChange: (event) => mobileOrchestrator.mirrorExternalApproval(event),
    },
    service: {
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
        taskInboxService?.scheduleRefresh();
      },
      sessionStateChanged: (sessionId, active, ownerId) => {
        sendToOwnerWindow(ownerId, "externalRuntime:sessionState", { sessionId, active });
        taskInboxService?.scheduleRefresh();
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
  showNotification: ({ title, body }) => {
    if (!Notification.isSupported()) return false;
    // Best-effort, same as the app's own agent notifications.
    new Notification({ title, body }).show();
    return true;
  },
  cookieCredentials: {
    taskCredentials: async (cwd) => {
      await migrateCredentialStore(cwd);
      return new CredentialStore(cwd).list();
    },
    list: async (cwd) => {
      await migrateCredentialStore(cwd);
      return new CredentialStore(cwd)
        .list()
        .filter((credential) => credential.type === "cookie")
        .map((credential) => {
          let health: "ready" | "corrupted" = "corrupted";
          try {
            const parsed = JSON.parse(credential.secret ?? "[]");
            if (Array.isArray(parsed)) health = "ready";
          } catch {
            // CredentialStore deliberately preserves undecryptable ciphertext.
            // Keep that value Host-only and expose only an actionable health bit.
          }
          return {
            id: credential.id,
            label: credential.label,
            health,
            domain: credential.meta?.domain,
            platform: credential.meta?.platform,
            appUrl: credential.meta?.appUrl,
            autoUseByAI: credential.autoUseByAI,
            autoInjectByAI: credential.autoInjectByAI,
            cookieExpiry: summarizeCookieExpiry(credential.secret),
          };
        });
    },
    loginAndSave: async ({ appId, providerId, providerLabel, url, cwd, bucket }) => {
      const capture = await loginAndCaptureCookies({
        url,
        platform: providerLabel,
        fullCapture: true,
      });
      if (!capture.ok) return capture;
      if (capture.jar.length === 0) {
        return { ok: false, error: "登录窗口没有捕获到 Cookie，请确认登录成功后再保存" };
      }
      const credentialId = `panel-${appId}__${providerId}`;
      const accountLabel =
        typeof capture.suggestedLabel === "string" && capture.suggestedLabel.trim()
          ? `${providerLabel} · ${capture.suggestedLabel.trim().slice(0, 80)}`
          : `${providerLabel} 登录`;
      const store = new CredentialStore(cwd);
      const previous = new CredentialStore().resolve(credentialId);
      cookieCredentialAutoRefresh.detachForCredential(cwd, credentialId, "user");
      store.save("user", {
        id: credentialId,
        type: "cookie",
        label: accountLabel,
        secret: JSON.stringify(capture.jar),
        meta: {
          ...(previous?.type === "cookie" ? previous.meta : {}),
          appUrl: url,
          platform: providerLabel,
          domain: capture.domain,
          scope: "all",
          switchMode: "merge",
        },
      });
      bridge?.pushCredentialSnapshot(cwd);

      let restoredCount = 0;
      const partition = browserPartitionForBucket(bucket);
      if (partition) {
        // Resolve the user record just saved, without project shadowing.
        const resolved = resolveCookieCredentialForBrowser(undefined, credentialId, "full");
        if (!resolved.ok) throw new Error(resolved.error);
        const restored = await restoreCookieCredentialToBrowser({
          targetSession: partition,
          sessionCwd: cwd,
          credentialId,
          credentialScope: "full",
          resolved,
        });
        restoredCount = restored.count;
        for (const window of BrowserWindow.getAllWindows()) {
          if (!window.isDestroyed()) window.webContents.send("browser:reload", { bucket });
        }
      }
      return {
        ok: true,
        credential: {
          id: credentialId,
          label: accountLabel,
          health: "ready",
          domain: capture.domain,
          platform: providerLabel,
          appUrl: url,
        },
        cookieCount: capture.jar.length,
        restoredCount,
      };
    },
    restore: async ({ credentialId, cwd, bucket }) => {
      const partition = browserPartitionForBucket(bucket);
      if (!partition) throw new Error("Cookie restore requires an active task browser");
      await migrateCredentialStore(cwd);
      const resolved = resolveCookieCredentialForBrowser(cwd, credentialId, "full");
      if (!resolved.ok) return { invalid: true };
      const result = await restoreCookieCredentialToBrowser({
        targetSession: partition,
        sessionCwd: cwd,
        credentialId,
        credentialScope: "full",
        resolved,
      });
      for (const window of BrowserWindow.getAllWindows()) {
        if (!window.isDestroyed()) window.webContents.send("browser:reload", { bucket });
      }
      return { count: result.count };
    },
    materialize: async ({ credentialId, cwd }) => {
      await migrateCredentialStore(cwd);
      const credential = new CredentialStore(cwd).resolve(credentialId);
      if (!credential || credential.type !== "cookie") {
        throw new Error(`No saved Cookie login: ${credentialId}`);
      }
      try {
        const materialized = materializeCookieSecret(credential.id, credential.secret ?? "");
        return {
          filePath: materialized.cookiesFile,
          count: materialized.count,
          cleanup: () => cleanupLease(materialized.cookiesFile),
        };
      } catch {
        return { invalid: true as const };
      }
    },
  },
  automations: {
    uniqueCreation: true,
    conditional: createDesktopPanelAutomationHost(desktopAutomationAuthorityDeps),
    list: async (scope) =>
      listAutomationsForResumeSession(scope.resumeSessionId, desktopAutomationAuthorityDeps()),
    create: async (input, scope) =>
      createAutomation(
        { ...input, resumeSessionId: scope.resumeSessionId },
        desktopAutomationAuthorityDeps(),
      ),
    update: async (id, patch, scope) =>
      updateAutomation(id, patch, desktopAutomationAuthorityDeps(), scope),
    pause: async (id) => pauseAutomation(id),
    resume: async (id) => resumeAutomation(id),
    delete: async (id) => deleteAutomation(id),
    runNow: async (id) => runAutomationNow(id),
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
const panelAppWindows = new PanelAppWindows({
  bridge: panelAppBridge,
  prepare: preparePanelApp,
  validateEntry: validatePanelAppEntryUrl,
  ownerWindow: (id) => BrowserWindow.fromId(id),
  createWindow: (options) => new BrowserWindow(options),
  createView: (options) => new WebContentsView(options),
  preloadPath: resolve(__dirname, "..", "preload", "panel-app.cjs"),
});
ipcMain.handle("panel-apps:open-window", async (event, target) => {
  const parent = BrowserWindow.fromWebContents(event.sender);
  if (!parent || !mainWindows.has(parent) || event.senderFrame !== event.sender.mainFrame) {
    throw new Error("Panel windows can only be opened from their Desktop tab");
  }
  await panelAppWindows.open(event.sender, target);
});
const imGatewayService = new ImGatewayService({
  ensureDesktopControl: async () => {
    if (!gatewayControlServer) throw new Error("Desktop 消息桥接尚未启动");
    await gatewayControlServer.start();
  },
  emit: (event) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send("im-gateway:event", event);
    }
  },
});
registerImGatewayIpc(ipcMain, imGatewayService);
let petStateAggregator: PetStateAggregator | null = null;
let petExternalVisibilityController: ExternalSessionVisibilityController | null = null;
let reconcileExternalAdapters: (() => Promise<void>) | null = null;
let petDispatchService: PetDispatchService | null = null;
let petRuleScheduler: PetRuleScheduler | null = null;
// The dispatcher exists before its worker and durable stores finish loading.
// IM delivery shares the same completed initialization boundary as Pet IPC.
let petRuntimeReady = false;
let petHostActionReceiptService: PetHostActionReceiptService | null = null;
let petNotices: PetNoticeWiring | null = null;
let petWorkInboxStore: PetWorkInboxStore | null = null;
let petLongTaskStore: PetLongTaskStore | null = null;
let petLongTaskCoordinator: PetLongTaskCoordinator | null = null;
const taskInboxDisposers: Array<() => void> = [];
const taskInboxAutomationSessions = new Map<string, string>();
let petImDecisions: PetImDecisions | null = null;
let unsubscribePetLongTaskStream: (() => void) | null = null;
let unsubscribePetReportStream: (() => void) | null = null;
let disposePetIpc: (() => void) | null = null;
let mcpOAuthService: McpOAuthService | null = null;
const linkDeviceOAuthBroker = new LinkDeviceOAuthBroker();
const managedCliInstallJobs = new Map<string, Promise<ManagedCliInstallResult>>();
let cspInstalled = false;
let automationHandle: AutomationHandle | null = null;
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

onPluginInstallJobsChanged((jobs) => {
  const installed = jobs.some((job) => job.status === "installed");
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send("plugins:installJobsChanged", jobs);
  }
  if (installed) broadcastPluginCommandsChanged(BrowserWindow.getAllWindows());
});

// ── Mobile Web Remote (LAN phone controller; off by default) ────────────────
// Trusted-device HTTP/WS host. Start is explicit in Settings → Advanced;
// commands reuse the existing run/permission path.
const mobileDevices = new TrustedDeviceStore(
  resolve(app.getPath("userData"), "mobile-remote", "devices.json"),
);
const mobileUploads = new MobileUploadService({
  rootDir: resolve(app.getPath("userData"), "mobile-remote", "uploads"),
});
const mobileRemote = new RemoteHostManager({
  nativeModelSelection: true,
  outputJournal: true,
  legacyBasePages: true,
  outputJournalPageFrames: 2048,
  historyView: true,
  devices: mobileDevices,
  uploads: mobileUploads,
  webApi: createDesktopWebService({
    devices: mobileDevices,
    automations: createDesktopPanelAutomationHost(desktopAutomationAuthorityDeps),
    sharedToolJobs: panelAppBridge.sharedToolJobs(),
    resolveProjectScope: resolvePanelProjectScope,
    resolvePanelProjectPath: (cwd) => resolveDesktopPanelProjectPath(getProjectStore(), cwd),
    authorizePanelDirectory: (app, projectPath, workspacePath) =>
      panelAppBridge.authorizePanelDirectory(app, projectPath, workspacePath),
    getBridge: () => bridge,
    captureRemoteAuthority: () => requireLinkAccountAccess(captureLinkAccount),
    remoteLink: () => deploymentRemoteLink(() => requireLinkAccountAccess(captureLinkAccount)),
    onPanelsChanged: (id, kind) => {
      if (kind === "remove") panelAppBridge.revokeAppId(id);
      broadcastPanelAppsChanged(BrowserWindow.getAllWindows());
    },
    resolveWorkspace: (input, deviceId) => mobileOrchestrator.resolveWebWorkspace(input, deviceId),
    relayStatus: () => mobileRemoteController.relayStatus(),
    phoneFeature: () => accountFeatures.snapshot()["relay.phone"],
    onSessionsChanged: (cwd, sessionId) => {
      const line = JSON.stringify({
        jsonrpc: "2.0",
        method: "serve/sessionsChanged",
        params: { cwd, sessionId },
      });
      mobileRemote.broadcastRaw(line);
      for (const window of BrowserWindow.getAllWindows()) {
        if (!window.isDestroyed()) window.webContents.send("agent:msg", line);
      }
    },
  }),
  // The built mobile web app stays a desktop asset (out/mobile, sibling of the
  // bundled out/main) — pass it explicitly now that RemoteHostManager lives in
  // @cjhyy/code-shell-server and can no longer derive it from its own location.
  // Packaged builds read it from app.asar.unpacked (see resolveMobileStaticRoot).
  mobileRootDir: resolveMobileStaticRoot(__dirname),
  onClientEvent: async (event) => {
    // The remote host tags authenticated events with both the device id and a
    // per-socket viewer id. Device state/replies remain shared per phone, while
    // transcript ownership follows the exact tab that subscribed.
    await mobileOrchestrator.handleMobileClientEvent(event as AuthenticatedMobileClientEvent);
  },
});
const pendingMobileApprovals = new PendingMobileApprovals();

// ── Public tunnel mode (off by default) ─────────────────────────────────────
// cloudflared binary manager, tunnel process manager, and the access passcode
// gate. All three live under <userData>/mobile-remote/. The tunnel is never
// auto-started; the user opts in from Settings, which routes through the
// mobileRemote:start IPC with { mode: "tunnel" }.
const cloudflaredBinary = new CloudflaredBinary({
  baseDir: resolve(app.getPath("userData"), "mobile-remote"),
});
const tunnelManager = new TunnelManager({
  binaryPath: () => cloudflaredBinary.binaryPath(),
});
const accessPasscode = new AccessPasscode({
  filePath: resolve(app.getPath("userData"), "mobile-remote", "access.json"),
});
let prepareAccountGitHubLink:
  | ReturnType<typeof registerRemoteLinkIpc>["prepareGitHubLink"]
  | undefined = undefined;
const { mobileRemoteController, cloudManagementManager, captureLinkAccount, accountFeatures } =
  createDesktopRemoteServices({
    app,
    ipcMain,
    userDataDir: app.getPath("userData"),
    environmentDir: join(codeShellHome(), "desktop"),
    listProjects: async () =>
      (await getProjectStore().list()).flatMap((project) => {
        const root = project.roots.find((entry) => entry.id === project.primaryRootId);
        return root ? [{ id: project.id, name: project.name, path: root.path }] : [];
      }),
    safeStorage,
    windows: () => mainWindows,
    openExternal: (url) => shell.openExternal(url),
    prepareGitHubLink: (signal, authorized) => {
      if (!prepareAccountGitHubLink) throw new Error("GitHub Link 服务尚未就绪。");
      return prepareAccountGitHubLink(signal, authorized);
    },
    host: mobileRemote,
    tunnel: tunnelManager,
    binary: cloudflaredBinary,
    passcode: accessPasscode,
    cloudWindows: { open: openManagedCloudWorkbench, close: closeManagedCloudWorkbench },
    openLegacyCloud: openCloudWorkbench,
  });
// Main-owned external runtimes use the same account gate as the stdio worker.
setDefaultCredentialAccess({
  ...localCredentialAccess,
  executeRemoteLinkAction: async (input, options) =>
    localCredentialAccess.executeRemoteLinkAction!(
      input,
      linkAccountExecutionOptions(captureLinkAccount, options),
    ),
});
let gatewayControlServer: GatewayControlServer | undefined;
let sessionBridge: SessionBridgeWiring | undefined;

/**
 * Publish once, then opportunistically hand the same event to the standalone
 * direct sender. When the live Gateway owns the stream the hand-off is a no-op;
 * when stopped, direct-capable adapters deliver it without task-layer coupling.
 */
async function publishGatewayControlEvent(event: GatewayControlEventInput): Promise<void> {
  const gateway = gatewayControlServer;
  if (!gateway) throw new Error("IM Gateway notification outbox is unavailable");
  handOffDirectDelivery(gateway, await gateway.publish(event));
}

/**
 * While the polling Gateway is stopped, direct-capable adapters deliver an
 * outbox event (a new one, or a retry copy the outbox appended) and report
 * its result like the live watcher does. Undefined: not handled here; the
 * event waits for the watcher. A send failure is reported so the outbox
 * retries or gives up; any other error leaves the event waiting, as before.
 */
function handOffDirectDelivery(
  gateway: GatewayControlServer,
  published: GatewayControlEvent,
): void {
  const context = gateway.eventContext();
  if (!context) return;
  const report = (
    result: Omit<Parameters<GatewayControlServer["reportEventResult"]>[0], "streamId" | "eventId">,
  ) => gateway.reportEventResult({ streamId: context.streamId, eventId: published.id, ...result });
  void imGatewayService
    .deliverPublishedNotification(published, {
      ...context,
      isLive: async () => gateway.isEventLive(context.streamId, published.id),
    })
    .then(async (delivery) => {
      if (delivery) await report({ outcome: delivery.outcome });
    })
    .catch(async (error: unknown) => {
      dlog("main", "im_gateway.notification_direct.failed", {
        eventId: published.id,
        type: published.type,
        error: String(error),
      });
      const failure = error as { attempted?: unknown; idempotent?: unknown };
      if (typeof failure?.attempted !== "boolean") return;
      await report({
        outcome: "failed",
        attempted: failure.attempted,
        idempotent: failure.idempotent === true,
        error: String(error).slice(0, 500),
      }).catch(() => undefined);
    });
}

function publishGatewayControlEventBestEffort(event: GatewayControlEventInput): void {
  void publishGatewayControlEvent(event).catch((error) =>
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
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send("mobileRemote:tunnelStatus", { status, detail });
  }
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
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send("mobileRemote:onlineChange", ids);
  }
});

// Rooms: resident stream-json Claude Code sessions the phone can open and chat
// with continuously (context persists for the room's lifetime). Messages are
// persisted to disk (authoritative) and mirrored to the phone. See
// docs/.../2026-06-07-mobile-rooms-external-agent-design.md.
const approvalBridge = new ApprovalBridge({
  onPush: (roomId, req) => {
    // Push the approval request to the renderer(s) (and phone via WS) so a user
    // can allow/deny. Mirrors the room:message dual-transport pattern.
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send("ccRoom:approvalRequest", { roomId, ...req });
    }
    mobileRemote.broadcast({ type: "ccRoom.approvalRequest", roomId, req });
  },
  onResolve: (roomId, requestId, decision) => {
    // Mirror resolution to BOTH transports so every端 clears its stale card —
    // fixes "点了/超时后审批卡不消失" across desktop windows + phones.
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed())
        w.webContents.send("ccRoom:approvalResolved", { roomId, requestId, decision });
    }
    mobileRemote.broadcast({ type: "ccRoom.approvalResolved", roomId, requestId, decision });
  },
});
const roomManager = new RoomManager({
  rootDir: resolve(app.getPath("userData"), "mobile-remote", "rooms"),
  modelTracing: {
    storageDir: join(sessionsRoot(), ".model-traces"),
    parameters: (room) =>
      room.kind === "codex" ? {} : { appendSystemPrompt: CC_COST_GUARD_PROMPT },
  },
  resolveLinkedSession: resolveLinkedSessionFromDisk,
  assertExternalSessionAvailable: backgroundWork.assertExternalSessionIdle,
  authorizeStart: (room) => roomModes.authorizeStart(room),
  onRoomClosed: (roomId) => roomModes.revoke(roomId),
  onRoomStateChanged: (roomId) => mobileOrchestrator.broadcastRoomState(roomId),
  createAgent: (room, onEvent) =>
    room.kind === "codex"
      ? new CodexRoomAgent({
          command: "codex",
          cwd: room.cwd,
          permissionMode: room.permissionMode,
          resumeThreadId: room.claudeSessionId,
          onEvent,
          // Persist codex's thread id so the next turn / app restart resumes it.
          onThreadId: (threadId) => roomManager.setRoomSessionId(room.id, threadId),
        })
      : new ResidentAgentProcess({
          command: "claude",
          cwd: room.cwd,
          permissionMode: room.permissionMode,
          resumeSessionId: room.claudeSessionId,
          appendSystemPrompt: CC_COST_GUARD_PROMPT,
          onEvent,
        }),
  onMessage: (roomId, msg) => {
    // Mirror to BOTH transports: phone (WS) and desktop renderer(s) (IPC), so
    // a room is dual-ended — same resident CC, same messages, either side sends.
    mobileOrchestrator.broadcastRoomMessage(roomId, msg);
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send("room:message", { roomId, msg });
    }
  },
  onApprovalRequest: (roomId, ev) => {
    void approvalBridge
      .request(roomId, ev.requestId, {
        toolName: ev.toolName,
        displayName: ev.displayName,
        input: ev.input,
        description: ev.description,
        askUser: ev.askUser,
      })
      .then((decision) => roomManager.respondApproval(roomId, ev.requestId, decision));
  },
  onRoomEnded: (roomId) => {
    approvalBridge.cancelRoom(roomId);
    transcriptSubscriptions.endRoom(roomId);
  },
});
const transcriptSubscriptions = createRoomTranscriptSubscriptions({
  roomManager,
  checkpointDir: join(app.getPath("userData"), "mobile-remote", "transcript-checkpoints"),
  broadcast: (event) => mobileRemote.broadcast(event),
  windows: () => BrowserWindow.getAllWindows(),
});
const roomModes = createDesktopRoomModeAuthority({ roomManager, approvalBridge });

// Routes authenticated mobile events into the same run/permission path the
// renderer uses (chat/approvals/sessions/rooms/cc-rooms). Extracted glue —
// see mobile-remote-orchestrator.ts.
const projectStore = getProjectStore();
const cloudEnvironment = registerCloudEnvironmentIpc({
  ipcMain,
  windows: () => mainWindows,
  userDataDir: app.getPath("userData"),
  assertLocalProject: (id) => projectStore.requireLive(id),
});
const mobileOrchestrator: MobileRemoteOrchestrator = new MobileRemoteOrchestrator({
  remote: mobileRemote,
  uploads: mobileUploads,
  pendingApprovals: pendingMobileApprovals,
  roomManager,
  approvalBridge,
  roomModes,
  transcriptSubscriptions,
  getBridge: () => bridge,
  getExternalRuntimeService: () => externalRuntime.service,
  getExternalRuntimeModels: () => externalRuntimeModelService.list(),
  getExternalRuntimeApprovals: () => externalRuntime.approvals,
  startMobileRuntime: (request) =>
    startMobileExternalRuntime(
      {
        service: () => externalRuntime.service,
        bridge: () => bridge,
        windows: () => mainWindows,
      },
      request,
    ),
  broadcastToWindows: (channel, payload) => {
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send(channel, payload);
    }
  },
});

initializeMobileRemoteLifecycle(
  mobileRemote,
  mobileOrchestrator,
  transcriptSubscriptions,
  roomManager,
);

/**
 * Harden the browser-panel <webview> guests hosted in `win`: no node, sandboxed,
 * isolated, web-security on, no renderer-driven popups, http(s)/about only — and
 * pin them to the shared `persist:browser` partition (a SEPARATE session from
 * defaultSession). The partition is what keeps the renderer-CSP `onHeadersReceived`
 * (registered on defaultSession) from touching guest requests, so a guest site's
 * own /_next/static/*.woff2 fonts aren't refused against our `font-src 'self'`.
 * Must run for EVERY window that hosts a BrowserPanel (main + browser popout).
 */
function hardenWebviewGuests(win: BrowserWindow): void {
  const pendingWebviews: Array<
    | { kind: "browser"; partition: string }
    | {
        kind: "panel-app";
        partition: string;
        resource: NonNullable<ReturnType<typeof validatePanelAppEntryUrl>>;
      }
  > = [];
  win.webContents.on("will-attach-webview", (event, webPreferences, params) => {
    const panelAppResource = validatePanelAppEntryUrl(String(params.src ?? ""));
    if (String(params.src ?? "").startsWith("cspanel:")) {
      if (
        !panelAppResource ||
        !preparedPanelAppPartitionProjectPath(
          panelAppResource.descriptor.hostId,
          String(params.partition ?? ""),
        )
      ) {
        event.preventDefault();
        return;
      }
      webPreferences.preload = resolve(__dirname, "..", "preload", "panel-app.cjs");
      webPreferences.nodeIntegration = false;
      webPreferences.nodeIntegrationInSubFrames = false;
      webPreferences.contextIsolation = true;
      webPreferences.sandbox = true;
      webPreferences.webSecurity = true;
      (params as Record<string, unknown>).allowpopups = false;
      pendingWebviews.push({
        kind: "panel-app",
        partition: String(params.partition),
        resource: panelAppResource,
      });
      return;
    }
    // Ignore any renderer/page-supplied preload and pin the audited minimal
    // guest bridge. It runs in Electron's isolated preload world and exposes
    // nothing to page JavaScript; only trusted clicks can sendToHost.
    webPreferences.preload = resolve(__dirname, "..", "preload", "browser-guest.cjs");
    webPreferences.nodeIntegration = false;
    webPreferences.nodeIntegrationInSubFrames = false;
    webPreferences.contextIsolation = true;
    webPreferences.sandbox = true;
    webPreferences.webSecurity = true;
    // Counterintuitive but required: `setWindowOpenHandler` (below) is ONLY
    // consulted when the guest has `allowpopups` — without it, Electron drops
    // target=_blank / window.open BEFORE the handler runs, so our "open as a new
    // tab" routing never fires (the "点了没反应" bug). We keep popups ENABLED here
    // and instead return {action:"deny"} from the handler to suppress the actual
    // OS popup window while still intercepting the URL. Not a security loosening:
    // every popup is denied; we only read its URL to open an in-app tab.
    (params as Record<string, unknown>).allowpopups = true;
    // Partition = the profile's cookie jar, shared by panel, task window and Cookie restore.
    // Refuse session-derived jars (nothing else writes them); absent → legacy shared partition.
    const wantPartition = typeof params.partition === "string" ? params.partition : "";
    if (wantPartition && !isProfileBrowserPartition(wantPartition)) {
      dlog("browser", "webview_partition_rejected", { partition: wantPartition.slice(0, 200) });
      event.preventDefault();
      return;
    }
    params.partition = wantPartition || BROWSER_PARTITION;
    pendingWebviews.push({ kind: "browser", partition: String(params.partition) });
  });
  win.webContents.on("did-attach-webview", (_e, guest) => {
    const attached = pendingWebviews.shift() ?? {
      kind: "browser" as const,
      partition: BROWSER_PARTITION,
    };
    if (attached.kind === "panel-app") {
      const projectPath = preparedPanelAppPartitionProjectPath(
        attached.resource.descriptor.hostId,
        attached.partition,
      );
      if (!projectPath) {
        guest.stop();
        return;
      }
      panelAppBridge.registerGuest(guest, win, attached.resource, projectPath);
      return;
    }
    const partition = attached.partition;
    rememberAttachedGuest({ guest, windowId: win.id, partition });
    // A page link wanting a new window (target=_blank, window.open) used to be
    // DENIED outright (→ kicked to the OS browser, or silently nothing — the
    // "点了没反应"). Instead, route http(s) popups back to the renderer to open as
    // a NEW TAB in the same browser panel, like a real browser. We still deny the
    // native popup window itself (no second OS window); non-http(s) is dropped.
    // Note: due to electron/electron#30886, this handler does NOT fire for
    // target=_blank link clicks in a <webview>. The reliable path is the
    // in-guest click interception injected by BrowserPanel (console sentinel →
    // open-in-app-tab). We keep this handler for window.open() calls that DO
    // reach it, and still deny the native popup either way.
    guest.setWindowOpenHandler(({ url }) => {
      if (/^https?:/i.test(url) && !win.isDestroyed()) {
        const bucket = guestRecordForId(guest.id)?.bucket;
        win.webContents.send("browser:open-tab", { url, bucket: bucket ?? undefined });
      }
      return { action: "deny" };
    });
    guest.on("will-navigate", (ev, url) => {
      if (!/^(https?|about):/i.test(url)) ev.preventDefault();
    });
  });
}

function sendWindowFullscreenState(win: BrowserWindow): void {
  if (win.isDestroyed()) return;
  win.webContents.send("window:fullscreen", { fullscreen: win.isFullScreen() });
}

async function createWindow(): Promise<BrowserWindow> {
  const ws = await loadWindowState();

  const win = new BrowserWindow({
    width: ws.width,
    height: ws.height,
    x: ws.x,
    y: ws.y,
    icon: resolve(__dirname, "..", "..", "build", "icon.png"),
    // macOS retains its traffic lights; Windows overlays native caption
    // buttons on the themed header instead of adding a second system bar.
    ...mainWindowTitleBarOptions(process.platform, nativeTheme.shouldUseDarkColors),
    // Windows/Linux: hide the native menu bar (文件/编辑/视图) by default so it
    // doesn't clutter the window — it looked out of place jammed inside the
    // frame (macOS has a global menu bar; win/linux render it in-window). Still
    // reachable via Alt, and every item also has a shortcut / in-app affordance.
    // No-op on macOS (global menu bar, not in-window).
    autoHideMenuBar: process.platform !== "darwin",
    webPreferences: {
      preload: resolve(__dirname, "..", "preload", "index.cjs"),
      additionalArguments: process.platform === "win32" ? ["--codeshell-titlebar-overlay"] : [],
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Enable <webview> for the built-in browser panel. The guest runs in its
      // own process/partition; we harden its webPreferences on attach below.
      webviewTag: true,
    },
  });
  mainWindows.add(win);

  // Harden the browser-panel <webview> guests for THIS window (main + popout
  // both host a BrowserPanel, so both need it — without it on the popout the
  // guest fell into defaultSession and inherited our renderer CSP, refusing the
  // site's own /_next/static fonts).
  hardenWebviewGuests(win);

  if (ws.maximized) win.maximize();

  // CSP installed once on the default session (sessions are shared
  // across windows, so re-installing per window would double-emit).
  //
  // Dev needs `'unsafe-inline'` for scripts because Vite's React plugin
  // injects an inline preamble for Fast Refresh — without it the
  // renderer fails to start. Dev also needs `connect-src ws://…` for
  // HMR and `style-src 'unsafe-inline'` for vite's style injection.
  //
  // Prod tightens script-src back to 'self'. Inline styles stay
  // permitted (highlight.js / react-markdown emit them).
  if (!cspInstalled) {
    cspInstalled = true;
    const isDev = Boolean(process.env.VITE_DEV_URL);
    const csp = isDev
      ? [
          // Vite HMR reconnects through a SharedWorker whose script is a
          // blob: URL. CSP's worker-src has no separate dev exception, so
          // we list blob: under script-src (worker-src falls back to it)
          // and add an explicit worker-src for clarity.
          "default-src 'self'; " +
            "script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:; " +
            "worker-src 'self' blob:; " +
            "style-src 'self' 'unsafe-inline'; " +
            `img-src 'self' data: blob: ${THEME_ASSET_SCHEME}:; ` +
            `media-src 'self' blob: ${THEME_ASSET_SCHEME}: ${MEDIA_PREVIEW_SCHEME}:; ` +
            "font-src 'self' data:; " +
            "connect-src 'self' ws: wss: http://localhost:* http://127.0.0.1:*; " +
            "object-src 'none'; " +
            "base-uri 'none'; " +
            "frame-ancestors 'none'",
        ]
      : [
          "default-src 'self'; " +
            "script-src 'self'; " +
            "worker-src 'self'; " +
            "style-src 'self' 'unsafe-inline'; " +
            `img-src 'self' data: ${THEME_ASSET_SCHEME}:; ` +
            `media-src 'self' blob: ${THEME_ASSET_SCHEME}: ${MEDIA_PREVIEW_SCHEME}:; ` +
            "font-src 'self' data:; " +
            // localhost connect is needed by the browser panel's dev-server
            // probe; without it the prod build can never detect local servers.
            "connect-src 'self' http://localhost:* http://127.0.0.1:*; " +
            "object-src 'none'; " +
            "base-uri 'none'; " +
            "frame-ancestors 'none'",
        ];
    // This CSP describes the *app's own* renderer (origin = the Vite dev URL
    // in dev, or file: in prod). The browser panel's <webview> guests live in
    // the "persist:browser" partition and load arbitrary external sites — they
    // must keep their OWN headers, or e.g. a Next.js site's self-hosted
    // /_next/static/media/*.woff2 fonts get refused against our `font-src
    // 'self' data:`. So scope the override to renderer-origin requests only.
    const rendererOrigin = process.env.VITE_DEV_URL ?? "";
    const isRendererRequest = (url: string): boolean =>
      url.startsWith("file://") ||
      (rendererOrigin !== "" && url.startsWith(rendererOrigin)) ||
      url.startsWith("devtools://");
    session.defaultSession.webRequest.onHeadersReceived((details, cb) => {
      if (!isRendererRequest(details.url)) {
        cb({ responseHeaders: details.responseHeaders });
        return;
      }
      cb({
        responseHeaders: {
          ...details.responseHeaders,
          "Content-Security-Policy": csp,
        },
      });
    });

    // Voice input (听写) needs microphone access via getUserMedia. Electron
    // denies media by default unless a handler grants it. Allow ONLY `media`,
    // and ONLY for our own renderer (the file:/dev-URL origin); deny everything
    // else — keeps the secure default while enabling the mic. The browser-panel
    // <webview> guests live in the separate "persist:browser" partition, so this
    // defaultSession handler does not touch their permissions.
    session.defaultSession.setPermissionRequestHandler((wc, permission, cb) => {
      // Allow ONLY for our own renderer (the file:/dev-URL origin); deny
      // everything else. `media` enables the mic. `clipboard-sanitized-write`
      // is what `navigator.clipboard.writeText` requests under the dev server's
      // http://localhost origin — without granting it, the copy buttons throw
      // `NotAllowedError: Write permission denied` (the file:// prod origin
      // skips the request, so this only bites in dev).
      if (permission === "media" || permission === "clipboard-sanitized-write") {
        cb(isRendererRequest(wc.getURL()));
        return;
      }
      cb(false);
    });
  }

  appRendererNavigation.bind(win.webContents);

  const devUrl = process.env.VITE_DEV_URL;
  const noDevtools = process.env.CODE_SHELL_NO_DEVTOOLS === "1";
  const loadRenderer = () => {
    if (devUrl) {
      void win.loadURL(devUrl);
      if (!noDevtools) win.webContents.openDevTools({ mode: "right" });
    } else {
      void win.loadFile(resolve(__dirname, "..", "renderer", "index.html"));
      if (!app.isPackaged && !noDevtools) win.webContents.openDevTools({ mode: "right" });
    }
  };

  win.webContents.on("did-fail-load", (_e, code, desc, url) => {
    dlog("main", "renderer.did-fail-load", { code, desc, url });
  });
  win.webContents.on("render-process-gone", (_e, details) => {
    mediaPreviewService.releaseOwner(win.webContents.id);
    dlog("main", "renderer.render-process-gone", { details });
  });
  win.webContents.on("preload-error", (_e, preloadPath, err) => {
    dlog("main", "renderer.preload-error", { preloadPath, message: err.message, stack: err.stack });
  });
  win.webContents.on("console-message", (_e, level, message, line, sourceId) => {
    dlog("renderer", "console", { level, message, line, sourceId });
  });
  win.webContents.on("did-finish-load", () => sendWindowFullscreenState(win));

  const persist = (): void => {
    if (win.isDestroyed()) return;
    const b = win.getBounds();
    void saveWindowState({
      width: b.width,
      height: b.height,
      x: b.x,
      y: b.y,
      maximized: win.isMaximized(),
    });
  };
  win.on("close", persist);
  win.on("resize", persist);
  win.on("move", persist);
  win.on("enter-full-screen", () => sendWindowFullscreenState(win));
  win.on("leave-full-screen", () => sendWindowFullscreenState(win));
  // macOS keeps the app alive after the last window closes, so ptys whose
  // window is gone would otherwise leak until quit. Reap them once the
  // webContents is actually torn down (next tick after `closed`).
  const ownerWebContentsId = win.webContents.id;
  win.webContents.once("destroyed", () => {
    mediaPreviewService.releaseOwner(ownerWebContentsId);
    rendererBrowserSessionAccess.forgetWindow(ownerWebContentsId);
  });
  win.webContents.on("did-start-navigation", (_event, _url, isInPlace, isMainFrame) => {
    if (isMainFrame && !isInPlace) {
      mediaPreviewService.releaseOwner(ownerWebContentsId);
      rendererBrowserSessionAccess.forgetWindow(ownerWebContentsId);
    }
  });
  // A reload starts with empty preload state; replay the runtimes Main still owns.
  win.webContents.on("did-finish-load", () => {
    for (const sessionId of externalRuntime.service?.ownedSessionIds(ownerWebContentsId) ?? [])
      win.webContents.send("externalRuntime:sessionState", { sessionId, active: true });
  });
  win.on("closed", () => {
    externalRuntime.approvals?.cancelWindow(ownerWebContentsId);
    void externalRuntime.service?.stopOwnedBy(ownerWebContentsId);
    mainWindows.delete(win);
    browserAnchorsByParent.delete(win.id);
    if (process.platform !== "darwin" && mainWindows.size === 0) {
      browserRuntime.closeAll();
    }
    setImmediate(ptyReapDestroyed);
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
        (await createAutomation(
          input as unknown as CreateAutomationInput,
          desktopAutomationAuthorityDeps(),
        )) as unknown as Record<string, unknown>,
      createDesktopModelRequestSigner({
        hostDirectory: codeShellHome(),
        sessionStorageDir: sessionsRoot(),
        cipher: new SafeStorageCipher(),
        encryptionAvailable: () =>
          safeStorage.isEncryptionAvailable() &&
          (process.platform !== "linux" ||
            safeStorage.getSelectedStorageBackend() !== "basic_text"),
        hasActiveEphemeralOwner: (sessionId) => quickChatOwnership.hasActiveOwner(sessionId),
        hasActiveHostTaskOwner: (sessionId) => panelAppBridge.hasActiveAgentTaskOwner(sessionId),
      }),
      captureLinkAccount,
      (sessionId, ownerId) => rendererBrowserSessionAccess.sessionOwnerClaimed(sessionId, ownerId),
    );
    // External Agent Runtimes (Codex / Claude Code). Everything
    // security-relevant is resolved here, in the composition root: this is the
    // only layer that knows the owning window, whether the project is trusted,
    // and which feature flags are on. The layers below deliberately refuse to
    // default any of it.
    const externalBridge = bridge;
    taskInboxDisposers.push(
      bridge.subscribeOutbound((_line, entry) => {
        const event = entry?.event as { type?: string } | undefined;
        if (
          event?.type &&
          [
            "session_started",
            "run_result",
            "approval_request",
            "approval_resolved",
            "ask_user",
            "agent_started",
            "agent_completed",
            "background_task_started",
            "background_task_completed",
          ].includes(event.type)
        ) {
          taskInboxService?.scheduleRefresh();
        }
      }),
    );
    desktopModules.start();

    const externalGoalSessions = new SessionManager();
    externalBridge.setExternalGoalRpcHandler(
      createExternalGoalRpcHandler({
        isExternalSession: (sessionId) => {
          if (externalRuntime.service?.get(sessionId)) return true;
          // The canonical model wins over an old external-runtime sidecar after
          // a user switches this task back to the native runtime.
          return !!parseExternalRuntimeModelKey(
            externalGoalSessions.readSessionState(sessionId)?.model,
          );
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
          const model = parseExternalRuntimeModelKey(state?.model);
          if (!state || !model) throw new Error("external goal task is no longer available");
          const cwd = await requireRendererProjectPath(state.cwd);
          const ownerWindow = [...mainWindows].find(
            (window) => !window.isDestroyed() && window.webContents.id === callerId,
          );
          if (!ownerWindow) throw new Error("goal owner window has closed");
          const existingOwner = externalBridge.panelOwnerWebContentsId(sessionId);
          if (existingOwner !== undefined && existingOwner !== callerId) {
            throw new Error("goal belongs to another window");
          }
          await service.ensure({
            kind: model.kind,
            sessionId,
            cwd,
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
      }),
    );

    bridge.subscribeOwnedExternalStream((entry) => {
      mobileOrchestrator.mirrorOwnedExternalStream(entry);
    });

    // Mirror every worker→renderer line onto any connected mobile clients, so
    // the phone sees the same stream (messages, tool summaries, approvals).
    bridge.subscribeOutbound((line, snapshotEntry) => {
      pendingMobileApprovals.setWorkerState(
        externalBridge.workerGeneration(),
        externalBridge.hasLiveWorker(),
      );
      pendingMobileApprovals.observeOutboundLine(line);
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
    const petMetadata = new PetMetadataStore(
      resolve(app.getPath("userData"), "pet", "metadata.json"),
    );
    const petWorkDelegationHost = new PetWorkDelegationHost({
      bridge,
      noWorkspaceCwd: resolveNoRepoCwd(),
      resolveSessionCwd: async (sessionId) => {
        const entry = await getSessionCwdIndex().refresh(sessionId);
        return entry?.status === "confirmed" ? (entry.workspaceRoot ?? entry.cwd) : undefined;
      },
      channelLabel: (channel) =>
        imGatewayService.ownerChannels().find((entry) => entry.id === channel)?.label,
    });
    const petWorkMemory = new PetWorkMemoryStore(
      resolve(app.getPath("userData"), "pet", "work-memory.json"),
    );
    const aggregator = new PetStateAggregator({
      bridge,
      listDiskSessions,
      // Every snapshot carries the durable topic-segment boundary history so the
      // Mimi chat UI can render segment dividers + brief cards; mid-session
      // changes ride notifyWorkMemorySegmentsChanged (see beginTurn wrapper).
      workMemorySegments: () => petWorkMemory.segmentBoundaries(),
      onBackgroundError: (operation, error) => {
        dlog("main", `pet.${operation}.failed`, { error: String(error) });
      },
    });
    petStateAggregator = aggregator;
    taskInboxDisposers.push(aggregator.subscribe(() => taskInboxService?.scheduleRefresh()));

    // Toggle-driven external-CLI session adapters (Codex / Claude). The
    // controller folds each session cwd's capabilityOverrides.pet over the
    // user baseline, and keeps a disabled source entirely unconstructed.
    const externalCliConfig = {
      codex: {
        discover: (scope: ExternalSessionDiscoveryScope) =>
          discoverRecentCodexSessions({ sinceMs: 24 * 60 * 60_000, limit: 50 }, undefined, scope),
        parseLine: parseCodexTranscriptLine,
      },
      claude: {
        discover: (scope: ExternalSessionDiscoveryScope) =>
          discoverRecentClaudeSessions({ sinceMs: 24 * 60 * 60_000, limit: 50 }, undefined, scope),
        parseLine: parseClaudeTranscriptLine,
      },
    } satisfies Record<
      ExternalCli,
      {
        discover: (
          scope: ExternalSessionDiscoveryScope,
        ) => ReturnType<typeof discoverRecentCodexSessions>;
        parseLine: (line: string) => ReturnType<typeof parseCodexTranscriptLine>;
      }
    >;

    const externalVisibility = new ExternalSessionVisibilityController({
      readUserSettings: () =>
        new SettingsManager(resolveNoRepoCwd(), "full").getForScope("user") as Record<
          string,
          unknown
        >,
      readProjectSettings: (cwd) =>
        new SettingsManager(cwd, "full").getForScope("project", cwd) as Record<string, unknown>,
      listProjectCwds: async () =>
        (await mobileOrchestrator.projectList()).map((project) => project.path),
      createAdapter: (cli, getDiscoveryScope, includeSession) =>
        new ExternalSessionAdapter({
          cli,
          discover: () => externalCliConfig[cli].discover(getDiscoveryScope()),
          parseLine: externalCliConfig[cli].parseLine,
          includeSession,
          sink: aggregator,
          onBackgroundError: (operation, error) =>
            dlog("main", `pet.external.${cli}.${operation}.failed`, { error: String(error) }),
        }),
      onSourceDisabled: (cli) => aggregator.removeExternalSessionsByCli(cli),
      onReconcileError: (cli, error) =>
        dlog("main", `pet.external.${cli}.reconcile.failed`, { error: String(error) }),
    });
    petExternalVisibilityController = externalVisibility;
    reconcileExternalAdapters = () => externalVisibility.reconcile();

    // The topic-segment controller is created inside petInitialization once the
    // durable pet session id is known; until then the dispatch service holds a
    // stable wrapper that no-ops (beginTurn → undefined; closure → nothing).
    let petSegmentController: PetSegmentController | null = null;
    const longTaskStore = new PetLongTaskStore(
      resolve(app.getPath("userData"), "pet", "long-tasks.json"),
    );
    petLongTaskStore = longTaskStore;
    taskInboxDisposers.push(longTaskStore.subscribe(() => taskInboxService?.scheduleRefresh()));
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
      .then((metadata) => (mimiSessionId = metadata.petSessionId))
      .catch(() => undefined);
    const notices = wirePetNotices({
      userDataDir: app.getPath("userData"),
      isMimiSession: (sessionId) => sessionId === mimiSessionId,
      bridge,
      projection: aggregator,
      longTasks: longTaskStore,
      sessionRoutes: () => sessionBridge?.routes,
      gateway: imGatewayService,
      outbox: {
        publish: publishGatewayControlEvent,
        revoke: async (deliveryKey) => {
          const gateway = gatewayControlServer;
          if (!gateway) throw new Error("IM Gateway notification outbox is unavailable");
          await gateway.revokeDelivery(deliveryKey, "notice-revoked");
        },
        state: (deliveryKey) => gatewayControlServer?.deliveryState(deliveryKey),
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
      externalApprovals: {
        approvals: () => externalRuntime.approvals,
        subscribe: (listener) => externalRuntime.subscribeApprovals(listener),
      },
      onWorkerLost: (keep) => sessionOutcomeDeriver.reset(keep),
      lastUserMessage: async (sessionId) => lastUserMessageIn(await getSessionEvents(sessionId)),
    });
    petNotices = notices;
    const petMemoryStoreInstance = new PetMemoryStore(
      resolve(app.getPath("userData"), "pet", "memories.json"),
    );
    void petMemoryStoreInstance
      .load()
      .catch((error) => dlog("main", "pet.memory.load.failed", { error: String(error) }));
    const petWorkInbox = new PetWorkInboxStore(
      resolve(app.getPath("userData"), "pet", "work-inbox.json"),
    );
    petWorkInboxStore = petWorkInbox;
    const petHostActionReceipts = new PetHostActionReceiptStore(
      resolve(app.getPath("userData"), "pet", "host-action-receipts.json"),
    );
    const petJournalStore = new PetJournalStore(
      resolve(app.getPath("userData"), "pet", "journal.json"),
    );
    void petJournalStore
      .load()
      .catch((error) => dlog("main", "pet.journal.load.failed", { error: String(error) }));
    // Built inside petInitialization once the durable pet session id is known.
    let petSegmentClosureService: PetSegmentClosureService | null = null;
    const longTaskCoordinator = new PetLongTaskCoordinator({
      store: longTaskStore,
      projection: aggregator,
      worker: bridge,
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
            : await enrichPetChatReplyWithHostActions(message, closureHostActions, {
                qrDir: resolve(app.getPath("userData"), "pet", "qr"),
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
    petLongTaskCoordinator = longTaskCoordinator;
    const decisionBridge = bridge;
    petImDecisions = new PetImDecisions({
      // The worker's decisions and the desktop external runtimes' (Codex / Claude Code).
      ...withExternalDecisions(
        notices.externalDecisions,
        {
          read: () => {
            pendingMobileApprovals.setWorkerState(
              decisionBridge.workerGeneration(),
              decisionBridge.hasLiveWorker(),
            );
            return collectImDecisions(
              aggregator.getSnapshot(),
              longTaskStore.getSnapshot().tasks,
              pendingMobileApprovals.replayAllLines(),
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
    const hostActionReceiptService = new PetHostActionReceiptService({
      sessionsRootDir: petSessionsRootDir,
      qrDir: resolve(app.getPath("userData"), "pet", "qr"),
      onPersistError: (error, input) =>
        dlog("main", "pet.hostActionReceipt.persist.failed", {
          petSessionId: input.petSessionId,
          clientMessageId: input.clientMessageId,
          error: String(error),
        }),
    });
    petHostActionReceiptService = hostActionReceiptService;
    // Lazy "Mimi 小结" closure-summary layer: a persistent store keyed by
    // session id + the aux summary service. summarize() is only called for
    // completed sessions on a workbench pull (see the summaries collector).
    const petSummaryStore = createPetSummaryStore(
      resolve(app.getPath("userData"), "pet", "summaries.json"),
    );
    void petSummaryStore
      .load()
      .catch((error) => dlog("main", "pet.summary.load.failed", { error: String(error) }));
    const petSummaryService = createPetSummaryService({
      sessionsRootDir: petSessionsRootDir,
      store: petSummaryStore,
      cwd: resolveNoRepoCwd(),
    });
    // Briefs and the heartbeat are system schedule rules on the same scheduler.
    const petProactive = wirePetProactive({
      notices,
      userDataDir: app.getPath("userData"),
      cwd: resolveNoRepoCwd(),
      tasks: () => longTaskStore.getSnapshot().tasks,
      projection: () => aggregator.getSnapshot(),
      log: (event, data) => dlog("main", event, data),
    });
    // Follow-ups are schedule rules; the old follow-ups.json is deleted, not migrated.
    const followUpRuntime = await createPetFollowUpRules({
      fireSystem: () => petProactive.fire,
      rules: notices.ruleStore,
      legacyFollowUpsPath: resolve(app.getPath("userData"), "pet", "follow-ups.json"),
      powerEvents: powerMonitor,
      sessions: () => aggregator.getSnapshot().sessions,
      summaryStore: petSummaryStore,
      summaryService: petSummaryService,
      inbox: petWorkInbox,
      tasks: longTaskStore,
      longTasks: longTaskCoordinator,
      scheduler: () => {
        if (!automationHandle) throw new Error("follow-up scheduler is not initialized");
        return automationHandle.scheduler;
      },
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
        // A chat bound to a Codex / CC Session sends to the worker: no turn of it is forwarded.
        createBoundSessionRunner(worker, aggregator, onTurn, sessionOutcomes, {
          ignores: externalSessions.isLive,
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
    petDispatchService = new PetDispatchService({
      metadata: petMetadata,
      aggregator,
      worker: bridge,
      hostCwd: resolveNoRepoCwd(),
      attachmentContext: new PetChatAttachmentContext(resolve(app.getPath("userData"), "pet")),
      sessionsRootDir: petSessionsRootDir,
      managerModel: async () =>
        petChatModelKeyFromSettings(await readSettings("user").catch(() => null)),
      personalization: async () =>
        petPersonalizationFromSettings(await readSettings("user").catch(() => null)),
      segmentController: {
        requestContextClear: async () => {
          if (!petSegmentController) throw new Error("Pet work-memory sink is not ready");
          await petSegmentController.requestContextClear();
        },
        beginTurn: async (clientMessageId) => {
          if (!petSegmentController) return undefined;
          const before = petSegmentController.segmentBoundaries().length;
          const brief = await petSegmentController.beginTurn(clientMessageId);
          // A new boundary means the chat UI must gain a divider now, not on the
          // next full snapshot fetch: push it through the projection channel.
          if (petSegmentController.segmentBoundaries().length !== before) {
            aggregator.notifyWorkMemorySegmentsChanged();
          }
          return brief;
        },
        completeSegmentClosure: (closed) =>
          petSegmentController?.completeSegmentClosure(closed) ?? Promise.resolve(),
        onDelegationClosed: (closure) =>
          petSegmentController?.onDelegationClosed(closure) ?? Promise.resolve(),
      },
      longTasks: longTaskCoordinator,
      validateFollowUpContinuation: followUpRuntime.validateContinuation,
      taskInbox: async () => {
        if (!taskInboxService || !taskInboxEnabled()) throw new Error("Task inbox is unavailable");
        return taskInboxPetView(await taskInboxService.reconcile());
      },
      hostActionReceipts: petHostActionReceipts,
      contextLinks: new PetContextLinkStore(
        resolve(app.getPath("userData"), "pet", "context-links.json"),
      ),
      // Atomic CodeShell capabilities Mimi may request via her host-action
      // tools; each runs only after her turn, and the real outcome is folded
      // into the reply. The key set gates which tools the worker exposes.
      hostActions: {
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
        longTaskControl: async (payload) => {
          const taskId = typeof payload.taskId === "string" ? payload.taskId : "";
          const action = payload.action;
          if (
            !taskId ||
            (action !== "pause" && action !== "resume" && action !== "retry" && action !== "cancel")
          ) {
            throw new Error("invalid long-task control request");
          }
          const controlled = await longTaskCoordinator.control({ taskId, action });
          if (!controlled.ok) throw new Error(controlled.message);
          return { action, objective: controlled.task.objective, status: controlled.task.status };
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
        memory: createPetMemoryHost(petMemoryStoreInstance),
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
      worldContext: createPetMemoryWorldContext(
        petMemoryStoreInstance,
        getMobileRemoteGatewayStatus,
      ),
      listWorkspaces: () => mobileOrchestrator.projectList(),
      listFollowUps: () => petFollowUps.listOpen(),
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
      // Second-chance lookup for a DelegateWork selector Mimi found via the
      // read-only Sessions tool: same opaque selector convention, resolved
      // against the on-disk catalog with the same pool boundaries as
      // listReusableSessions (desktop origin, not archived).
      resolveReusableSessionBySelector: createReusableSessionResolver(petSessionsRootDir),
      listReusableSessions: async () => {
        const noWorkspaceCwd = resolveNoRepoCwd();
        // No includeArchived: listDiskSessions default-filters archived rows, so
        // auto-archived sessions leave the reuse-candidate pool automatically
        // while completed-but-not-yet-archived sessions stay reusable. `status`
        // rides along to the candidate description.
        const { sessions } = await listDiskSessions({ limit: 100 });
        return sessions
          .filter((session) => session.origin === "desktop")
          .map((session) => ({
            sessionId: session.engineSessionId,
            workspacePath:
              resolve(session.cwd || noWorkspaceCwd) === resolve(noWorkspaceCwd)
                ? null
                : session.cwd,
            title: session.title,
            updatedAt: session.updatedAt,
            status: session.status,
          }));
      },
      startWorkSession: (delegation) => longTaskCoordinator.startDelegation(delegation),
    });
    const processingPetReports = new Set<string>();
    const deliveredPetReports = new PetReportReceiptStore(
      resolve(app.getPath("userData"), "pet", "report-receipts.json"),
    );
    unsubscribePetReportStream = bridge.subscribePetReports(async (event) => {
      if (processingPetReports.has(event.reportId)) return;
      processingPetReports.add(event.reportId);
      try {
        if (await deliveredPetReports.has(event.reportId)) return;
        const task = longTaskStore.activeForSession(event.sessionId);
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
            ? await enrichPetChatReplyWithHostActions(report.text, report.hostActions, {
                qrDir: resolve(app.getPath("userData"), "pet", "qr"),
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
          const enriched = await enrichPetChatReplyWithHostActions(
            report.text,
            report.hostActions,
            {
              qrDir: resolve(app.getPath("userData"), "pet", "qr"),
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
      await externalVisibility.reconcile();
      await Promise.all([
        notices.ready,
        petWorkInbox.load(),
        petHostActionReceipts.load(),
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
      const autoExtractEnabled = (): boolean => {
        try {
          return petMemoryAutoExtractFromSettings(
            new SettingsManager(resolveNoRepoCwd(), "full").getForScope("user"),
          );
        } catch {
          return true; // default ON if settings are unreadable
        }
      };
      // Segment-closure pipeline: distill a journal entry + auto-memories from
      // each closed Mimi topic segment. Context archival is requested on the
      // boundary agent/run itself, after its user message is appended and
      // before the first model call, so the end anchor cannot race turn startup.
      petSegmentClosureService = createPetSegmentClosureService({
        petSessionId,
        sessionsRootDir: petSessionsRootDir,
        journal: petJournalStore,
        memory: petMemoryStoreInstance,
        autoExtractEnabled,
        cwd: resolveNoRepoCwd(),
      });
      const closureService = petSegmentClosureService;
      // Defense-in-depth against a segment's range being archived twice.
      // archive_range uses absolute message indices; a second archive of the
      // same segment would run on now-shifted indices and remove the wrong
      // turns. The controller serializes beginTurn to prevent a double close,
      // and this set guarantees at-most-once archival per segment regardless.
      const closedSegmentIds = new Set<string>();
      petSegmentController = new PetSegmentController({
        store: petWorkMemory,
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
        now: Date.now,
        idleMs: DEFAULT_SEGMENT_IDLE_MS,
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
        if (!autoExtractEnabled()) {
          dlog("main", "pet.contextMigration.skippedAutoExtractOff", { petSessionId });
          return;
        }
        await backfillPromise.catch(() => undefined);
        const activeSegment = petWorkMemory.activeSegment();
        // Ensure the journal is loaded before snapshotting (idempotent/memoized;
        // same pattern as the journal.list() IPC handler above) — otherwise a
        // slow-disk cold start could read an empty list and skip migration for
        // this launch entirely.
        await petJournalStore.load();
        // PetJournalStore.list() is newest-first (sorted by endedAt desc); the
        // migration summary must read oldest→newest, so reverse a copy here.
        const journalEntries = [...petJournalStore.list()].reverse();
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
      notices: createPetNoticeControls({
        notices,
        ownerChannels: () => imGatewayService.ownerChannels(),
        goals: externalGoalSessions,
        proactive: () => petProactive.status(),
        writeNotificationSettings: async (notifications) => {
          await writeSettings("user", { pet: { notifications } });
          notices.settingsChanged();
        },
        cancelFollowUp: (followUpId, expectedRevision) =>
          followUpHost({ action: "cancel", followUpId, expectedRevision }),
      }),
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
        control: (request) => longTaskCoordinator.control(request),
        clearTerminal: () => longTaskCoordinator.clearTerminal(),
        clearTask: (taskId) => longTaskCoordinator.clearTerminalTask(taskId),
        subscribe: (listener) => longTaskStore.subscribe(listener),
      },
      memories: {
        list: async () => {
          await petMemoryStoreInstance.load();
          return petMemoryStoreInstance.list();
        },
        remember: (text) => petMemoryStoreInstance.remember(text, "user"),
        update: (id, text) => petMemoryStoreInstance.update(id, text),
        forget: (id) => petMemoryStoreInstance.forget(id),
        subscribe: (listener) => petMemoryStoreInstance.subscribe(listener),
      },
      latestResult: createLatestResultCache(petSessionsRootDir),
      summaries: {
        collect: () => petFollowUps.collect(),
        control: (request) => followUpHost({ ...request }),
        subscribe: followUpRuntime.subscribe,
      },
      journal: {
        list: async () => {
          await petJournalStore.load();
          return petJournalStore.list();
        },
        subscribe: (listener) => petJournalStore.subscribe(listener),
        readSegmentMessages: async (range) =>
          petSegmentClosureService ? petSegmentClosureService.readSegmentMessages(range) : [],
      },
      preferences: {
        getAutoExtract: async () =>
          petMemoryAutoExtractFromSettings(await readSettings("user").catch(() => null)),
        setAutoExtract: async (enabled) => {
          await writeSettings("user", petMemoryAutoExtractSettingsPatch(enabled));
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
/**
 * Every disk session, consumed page by page.
 *
 * Several callers used a bare `listDiskSessions({ limit: 1_000 })` and treated
 * the result as "all sessions". Once a user passed 1,000 sessions that silently
 * became a window: archiving a specific session by id would report "不存在"
 * merely because it fell outside the newest 1,000, and the auto-archive sweep —
 * whose comment claims a full catalog pass — quietly stopped seeing the oldest,
 * i.e. exactly the ones most likely to be archivable.
 *
 * `maxPages` is a runaway guard, not a cap: hitting it is logged rather than
 * silently truncating.
 */
async function listAllDiskSessions(
  opts: { includeSubagents?: boolean } = {},
): Promise<Awaited<ReturnType<typeof listDiskSessions>>["sessions"]> {
  const pageSize = 500;
  const maxPages = 200;
  const all: Awaited<ReturnType<typeof listDiskSessions>>["sessions"] = [];
  let cursor: string | undefined;
  for (let page = 0; page < maxPages; page += 1) {
    const result = await listDiskSessions({
      limit: pageSize,
      includeArchived: true,
      ...(opts.includeSubagents ? { includeSubagents: true } : {}),
      ...(cursor ? { cursor } : {}),
    });
    all.push(...result.sessions);
    if (!result.nextCursor) return all;
    cursor = result.nextCursor;
  }
  dlog("main", "listAllDiskSessions.page_limit", { maxPages, scanned: all.length });
  return all;
}

async function runPetAutoArchive(aggregator: PetStateAggregator): Promise<void> {
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

/** Build the hidden docked-widget window; the surface decides when it shows. */
function createPetWidgetBrowserWindow(bounds: {
  x: number;
  y: number;
  width: number;
  height: number;
}): BrowserWindow {
  const win = new BrowserWindow({
    ...bounds,
    // An ordinary NSWindow of a regular app is not drawn over another app's
    // fullscreen Space, so the docked pet vanished on any display showing one
    // (multi-display acceptance 2026-11-02). A panel joins those Spaces, like
    // the moving form; its inline chat still takes keyboard focus on click.
    ...(process.platform === "darwin" ? { type: "panel" as const } : {}),
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    hasShadow: false,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    // macOS owns one Dock icon per application, not per BrowserWindow. Setting
    // skipTaskbar on the Pet would hide CodeShell itself from the Dock.
    skipTaskbar: shouldSkipPetWidgetTaskbar(process.platform),
    alwaysOnTop: true,
    acceptFirstMouse: true,
    webPreferences: {
      preload: resolve(__dirname, "..", "preload", "index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Keep the pet animation and live activity state responsive while
      // CodeShell itself is behind another application.
      backgroundThrottling: false,
    },
  });
  // Register the widget window with the agent bridge so it receives live
  // agent:msg / agent:streamEvent broadcasts. Without this the widget's chat
  // only updates on a fresh transcript hydrate (opening the panel or a restart)
  // — the in-place reply never streams in. attachWindow self-removes on close,
  // so re-creating the widget re-attaches cleanly.
  bridge?.attachWindow(win);
  if (process.platform === "darwin") {
    void app.dock?.show();
    win.setHiddenInMissionControl(true);
  }
  try {
    // The panel needs no process-type round trip (UIElement and back) to join
    // fullscreen Spaces; skipping it also keeps the Dock icon from flickering.
    win.setVisibleOnAllWorkspaces(true, {
      visibleOnFullScreen: true,
      skipTransformProcessType: true,
    });
  } catch {
    // Some Linux window managers do not implement workspace pinning.
  }
  appRendererNavigation.bind(win.webContents);
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (event) => event.preventDefault());
  win.webContents.on("did-fail-load", (_event, code, desc, validatedUrl) => {
    dlog("main", "pet-widget.did-fail-load", { code, desc, validatedUrl });
  });
  win.webContents.on("console-message", (_event, level, message, line, sourceId) => {
    if (level >= 2) dlog("main", "pet-widget.console", { level, message, line, sourceId });
  });
  return win;
}

async function loadPetWidgetBrowserWindow(win: BrowserWindow, role?: "bubble"): Promise<void> {
  const query: Record<string, string> = { popout: "pet", ...(role ? { role } : {}) };
  const devUrl = process.env.VITE_DEV_URL;
  if (devUrl) {
    const url = new URL(devUrl);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    await win.loadURL(url.toString());
  } else {
    await win.loadFile(resolve(__dirname, "..", "renderer", "index.html"), { query });
  }
}

function broadcastMimiPresence(snapshot: MimiPresenceSnapshot): void {
  mimiBubble?.sync(snapshot);
  const visible = effectiveMimiVisible(snapshot);
  for (const win of mainWindows) {
    if (win.isDestroyed()) continue;
    win.webContents.send("mimi:presence-changed", snapshot);
    win.webContents.send("pet:widget-visibility-changed", visible);
  }
  // The docked widget draws the chosen character too.
  for (const win of petSurfaceWindows()) win.webContents.send("mimi:presence-changed", snapshot);
}

/**
 * Load (or migrate) the unified presence file and create its owner. Neither
 * form is shown until `startMimiPresence` runs after computer use is composed.
 */
async function createMimiPresence(): Promise<MimiPresenceController> {
  const paths = {
    statePath: join(codeShellHome(), "desktop", MIMI_PRESENCE_FILE),
    legacyCompanionPath: join(app.getPath("userData"), "mimi-companion.json"),
    legacyWidgetPath: petWidgetWindowStatePath(),
  };
  const loaded: MimiPresenceLoadResult = await loadMimiPresenceState(paths).catch((error) => {
    dlog("main", "mimi-presence.load.failed", { error: String(error) });
    return { state: defaultMimiPresenceState(), source: "default" as const };
  });
  if (loaded.quarantined) dlog("main", "mimi-presence.quarantined", { copy: loaded.quarantined });
  const write = createMimiPresenceWriter(paths.statePath);
  const surface = createPetWidgetSurface({
    platform: process.platform,
    screen: {
      getDisplayNearestPoint: (point) => screen.getDisplayNearestPoint(point),
      getPrimaryDisplay: () => screen.getPrimaryDisplay(),
      on: (event, listener) => screen.on(event as "display-removed", listener),
      removeListener: (event, listener) =>
        screen.removeListener(event as "display-removed", listener),
    },
    ready: () => petIpcReady,
    createWindow: createPetWidgetBrowserWindow,
    load: (win) => loadPetWidgetBrowserWindow(win as BrowserWindow),
    loadAnchor: () => mimiPresence?.anchor("docked"),
    saveAnchor: (anchor) => mimiPresence?.rememberAnchor("docked", anchor),
    onFailure: (error) => mimiPresence?.surfaceFailed("docked", error),
    log: (event, data) => dlog("main", event, data),
  });
  petWidgetSurface = surface;
  mimiBubble = createMimiBubbleHost({
    platform: process.platform,
    screen,
    ipcMain,
    ready: () => petIpcReady,
    createWindow: createPetWidgetBrowserWindow,
    load: (win) => loadPetWidgetBrowserWindow(win as BrowserWindow, "bubble"),
    companion: getMimiCompanion,
    openOverview: openPetOverviewFromWidget,
    log: (event, data) => dlog("main", event, data),
  });
  const controller = new MimiPresenceController({
    initial: loaded.state,
    docked: surface,
    save: write,
    onChange: broadcastMimiPresence,
    log: (event, data) => dlog("main", event, data),
  });
  mimiPresence = controller;
  // One-time migration: write the new file; legacy files stay untouched for rollback.
  if (loaded.source === "migrated") {
    dlog("main", "mimi-presence.migrated", {
      visible: loaded.state.visible,
      mode: loaded.state.mode,
      size: loaded.state.size,
    });
    void write(loaded.state).catch(() => {});
  }
  resolveMimiPresence?.(controller);
  resolveMimiPresence = null;
  return controller;
}

/** Present only after pet IPC and computer use are both composed: no startup flash. */
function startMimiPresence(controller: MimiPresenceController): void {
  void petIpcReady.then(() =>
    controller.start({
      surface: getMimiCompanion(),
      unavailableReason: mimiMovingUnavailableReason(),
    }),
  );
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

/** Tracks the popout browser windows so we can route anchors back to a parent. */
const popoutParents = new Map<number, number>(); // popout wc id -> parent window id
const browserAnchorsByParent = new Map<number, unknown[]>();

/**
 * Open a standalone browser window (the popout). It loads the same renderer
 * with `?popout=browser`, which mounts just the browser panel full-window.
 * Element-pick anchors made in here are forwarded to `parent` so they land in
 * the main window's composer.
 */
async function createBrowserPopout(parent: BrowserWindow, initialUrl?: string): Promise<void> {
  const win = new BrowserWindow({
    width: 1100,
    height: 800,
    title: "浏览器",
    webPreferences: {
      preload: resolve(__dirname, "..", "preload", "index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: true,
    },
  });
  appRendererNavigation.bind(win.webContents);
  const wcId = win.webContents.id;
  popoutParents.set(wcId, parent.id);
  win.on("closed", () => popoutParents.delete(wcId));
  // Same guest hardening as the main window — the popout hosts a BrowserPanel
  // too, so without this its <webview> guest landed in defaultSession and got
  // our renderer CSP (refusing the site's own fonts). Pins it to persist:browser.
  hardenWebviewGuests(win);

  // Diagnose a blank popout: surface load failures + the popout renderer's own
  // console errors into the main log (the popout has no DevTools by default).
  win.webContents.on("did-fail-load", (_e, code, desc, validatedUrl) => {
    dlog("main", "browser-popout.did-fail-load", { code, desc, validatedUrl });
  });
  win.webContents.on("console-message", (_e, level, message, line, sourceId) => {
    if (level >= 2) dlog("main", "browser-popout.console", { level, message, line, sourceId });
  });

  const query: Record<string, string> = { popout: "browser" };
  if (initialUrl) query.url = initialUrl;
  const devUrl = process.env.VITE_DEV_URL;
  try {
    if (devUrl) {
      const u = new URL(devUrl);
      for (const [k, v] of Object.entries(query)) u.searchParams.set(k, v);
      dlog("main", "browser-popout.loadURL", { url: u.toString() });
      await win.loadURL(u.toString());
    } else {
      dlog("main", "browser-popout.loadFile", { query });
      await win.loadFile(resolve(__dirname, "..", "renderer", "index.html"), { query });
    }
    // Seed the freshly-loaded popout with the current anchor snapshot so it
    // echoes annotations made before it was opened (state-down pipe).
    if (!win.isDestroyed()) {
      win.webContents.send("browser:anchors-state", browserAnchorsByParent.get(parent.id) ?? []);
    }
  } catch (e) {
    dlog("main", "browser-popout.load-threw", { error: String(e) });
  }
}

/**
 * Push the user's `git.path` setting (if any) into core's git resolver, so
 * marketplace clones / worktrees use the configured binary even when a GUI
 * launch didn't inherit the user's PATH. Re-run after settings change. Reads
 * only the user scope — git location is a machine-level preference.
 */
async function applyGitPathFromSettings(): Promise<void> {
  try {
    const s = ((await readSettings("user").catch(() => null)) ?? {}) as {
      git?: { path?: unknown };
    };
    const p = typeof s.git?.path === "string" ? s.git.path : null;
    setGitPathOverride(p);
  } catch {
    setGitPathOverride(null);
  }
}

function writeSettingsSchemaAtStartup(): void {
  try {
    writeSettingsSchemaFile(join(userHome(), ".code-shell"));
  } catch {
    // Best-effort editor aid; desktop startup must not depend on schema writes.
  }
}

async function knownAttachmentCwds(): Promise<string[]> {
  const out = new Set<string>();
  try {
    for (const project of await loadProjects()) {
      if (typeof project.path === "string" && project.path) out.add(project.path);
    }
  } catch {
    // best effort
  }
  try {
    out.add(resolveNoRepoCwd());
  } catch {
    // best effort
  }
  return [...out];
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

async function cleanupKnownAttachments(sessionId?: string): Promise<void> {
  for (const cwd of await knownAttachmentCwds()) {
    if (sessionId) {
      await cleanupSessionAttachments(cwd, sessionId).catch(() => undefined);
    } else {
      await cleanupAttachments({ cwd }).catch(() => undefined);
    }
  }
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
    return await dispatchGatewayPetTurn(request, dispatcher, sessionId, decisionReply);
  } finally {
    decisionReply?.abandoned();
  }
}

async function dispatchGatewayPetTurn(
  request: PetChatControlRequest,
  dispatcher: PetDispatchService,
  sessionId: string,
  handoff: Exclude<Awaited<ReturnType<PetImDecisions["reply"]>>, string>,
): Promise<PetChatControlResult> {
  const message = handoff?.handoff ?? request.message;
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

  const sourceChannel =
    request.origin?.channel
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]/g, "-")
      .slice(0, 32) || "unknown";
  const clientMessageId = request.origin?.messageId
    ? `im:${sourceChannel}:${stablePromptHash(
        `${request.origin.channel}\0${request.origin.target}\0${request.origin.senderId}\0${request.origin.messageId}`,
      )}`
    : `im:${sourceChannel}:${randomUUID()}`;
  const submitted = {
    kind: "user-submitted" as const,
    clientMessageId,
    message: request.message.trim(),
    ...(attachments.length > 0
      ? {
          attachments: attachments.map(
            ({ kind, path, absPath, sessionId, mime, originalName }) => ({
              kind,
              path,
              absPath,
              sessionId,
              ...(mime ? { mime } : {}),
              ...(originalName ? { originalName } : {}),
            }),
          ),
        }
      : {}),
    createdAt: Date.now(),
    ...(request.origin ? { origin: request.origin } : {}),
  };
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send(PET_CHAT_EVENT_CHANNEL, submitted);
  }

  // Notices this conversation missed ride the turn as data, taken when it starts.
  const replay = petNotices?.inboundReplay(request.origin);
  const result = await dispatcher
    .dispatch({
      type: "chat",
      message,
      ...(attachments.length > 0 ? { attachments } : {}),
      ...(replay ? { pendingNotices: replay } : {}),
      clientMessageId,
      source: {
        kind: "im-gateway",
        channel: sourceChannel,
        ...(request.origin?.senderId ? { senderId: request.origin.senderId } : {}),
        isDirectMessage: request.origin?.isDirectMessage === true,
        capabilities: request.origin?.capabilities ?? {
          inbound: { text: true, attachments: [] },
          outbound: { text: true, button: "link", attachments: [] },
        },
        ...(request.origin?.channels ? { channels: request.origin.channels } : {}),
        ...(request.origin ? { target: request.origin.target } : {}),
      },
    })
    .then(
      (dispatched) => {
        if (dispatched.ok) void handoff?.dispatched();
        else handoff?.abandoned();
        return dispatched;
      },
      (error: unknown) => {
        handoff?.abandoned();
        throw error;
      },
    )
    .finally(() => replay?.finish());
  if (!result.ok) throw new Error(result.message ?? result.code);
  if (result.type !== "chat") throw new Error("Mimi Pet 返回了非聊天结果");
  await markAttachmentsSent(cwd, sessionId, attachments).catch(() => undefined);
  if (result.suppressReply) {
    return {
      text: "",
      petSessionId: result.petSessionId,
      reason: "steered",
      suppressReply: true,
    };
  }
  const worker = result.result as { text?: unknown; reason?: unknown } | undefined;
  // Host-executed action outcomes (real tunnel address + pairing QR, task
  // state changes, memory confirmations) are appended here so the IM reply
  // carries what Mimi could only promise during her turn.
  const enriched = await enrichPetChatReplyWithHostActions(
    result.authoritativeReply ?? (typeof worker?.text === "string" ? worker.text : ""),
    result.hostActions,
    {
      qrDir: resolve(app.getPath("userData"), "pet", "qr"),
      authoritativeBaseText: Boolean(result.authoritativeReply),
      attachmentKinds: request.origin?.capabilities.outbound.attachments.filter(
        (kind): kind is "image" | "file" | "audio" | "video" =>
          ["image", "file", "audio", "video"].includes(kind),
      ),
    },
  );
  const replacesGatewayTurn =
    Boolean(result.authoritativeReply) ||
    Boolean(
      result.hostActions?.some(
        (execution) => execution.kind === "gatewayReply" || execution.kind === "sessionBind",
      ),
    );
  if (
    (replacesGatewayTurn ||
      result.hostActions?.some((execution) => execution.kind === "outboundMessage")) &&
    petHostActionReceiptService
  ) {
    await completePetHostActionReceipt({
      recorder: petHostActionReceiptService,
      input: {
        petSessionId: result.petSessionId,
        clientMessageId,
        executions: result.hostActions ?? [],
        authoritativeMessage: enriched.text,
        ...(result.contextCleared ? { userMessage: request.message.trim() } : {}),
        ...(replacesGatewayTurn
          ? {
              replaceAssistant: true,
              deliveryChannel: sourceChannel,
            }
          : {}),
      },
      publish: (receiptEvent) => {
        for (const window of BrowserWindow.getAllWindows()) {
          if (!window.isDestroyed()) {
            window.webContents.send(PET_CHAT_EVENT_CHANNEL, receiptEvent);
          }
        }
      },
    }).catch((error) =>
      dlog("main", "pet.hostActionReceipt.gateway.failed", {
        petSessionId: result.petSessionId,
        clientMessageId,
        error: String(error),
      }),
    );
  }
  return {
    text: enriched.text,
    petSessionId: result.petSessionId,
    ...(typeof worker?.reason === "string" ? { reason: worker.reason } : {}),
    ...(enriched.button ? { button: enriched.button } : {}),
    ...(enriched.attachments.length > 0 ? { attachments: enriched.attachments } : {}),
  };
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

app.whenReady().then(async () => {
  if (!ownsDesktopInstance) return;
  desktopNotifier = new DesktopNotifier(
    resolve(app.getPath("userData"), "notifications", "delivered.json"),
    {
      hasFocusedWindow: () => BrowserWindow.getFocusedWindow() !== null,
      isSupported: () => Notification.isSupported(),
      show: (input) =>
        showNativeDesktopNotification(input, {
          create: (options) => new Notification(options),
          openSession: revealSessionWindow,
        }),
    },
  );
  await projectStore.warm();
  writeSettingsSchemaAtStartup();
  void cleanupKnownAttachments();
  // The main window and the pet popout both render on the default session, so
  // one handler there serves cstheme:// assets to every window.
  installThemeAssetProtocol();
  session.defaultSession.protocol.handle(MEDIA_PREVIEW_SCHEME, (request) =>
    mediaPreviewService.respond(request),
  );

  await chromeExtensionRuntimeService.start().catch((error) => {
    dlog("browser", "chrome_extension_bridge_start_failed", { error: String(error) });
  });
  // One owner for Mimi's desktop presence; nothing is shown until it starts.
  const presence = await createMimiPresence();
  // Register the opt-in host before the first worker receives its MCP environment.
  try {
    await initializeDesktopComputerUse({
      app,
      openCompanionChat: async (request, near) =>
        mimiBubble?.open("chat", near, request?.prompt, request?.send),
      openCompanionActivity: async (near) => mimiBubble?.open("activity", near),
      onCompanionMoved: (near) => mimiBubble?.surface.follow(near),
      ipcMain,
      openExternal: (url) => shell.openExternal(url),
      isMainWindow: isMainWindowSender,
      // The docked inline chat is a Mimi chat too: it may hold foreground input.
      isCompanionChatSurface: (sender) =>
        isMainWindowSender(sender) ||
        Boolean(petWidgetSurface?.owns(sender.id) || mimiBubble?.surface.owns(sender.id)),
      companionPresence: {
        initial: { size: presence.persisted().size, anchor: presence.anchor("moving") },
        onAnchorChange: (anchor) => presence.rememberAnchor("moving", anchor),
        onFailure: (error) => presence.surfaceFailed("moving", error),
        onPreviewEnd: () => presence.previewEnded(),
        onCaptureChange: (capturing) => presence.setCaptureActive(capturing),
        request: (patch) => void presence.set(patch),
      },
      companionSettings: legacyCompanionSettings(mimiPresenceOwner),
      cwd: resolveNoRepoCwd,
      platform: process.platform,
      resourcesPath: process.resourcesPath,
      env: process.env,
      log: (event, data) => dlog("computer-use", event, data),
    });
  } finally {
    startMimiPresence(presence);
  }
  chromeNativeRegistration = await installChromeNativeMessagingHost({
    executablePath: process.execPath,
    appPath: app.getAppPath(),
    resourcesPath: process.resourcesPath,
    isPackaged: app.isPackaged,
  }).catch((error) => ({
    installed: false,
    manifestPaths: [],
    extensionPath: app.isPackaged
      ? join(process.resourcesPath, "packages", "desktop", "resources", "chrome-extension")
      : join(app.getAppPath(), "resources", "chrome-extension"),
    detail: String(error),
  }));

  gatewayControlServer = new GatewayControlServer({
    descriptorPath: join(userHome(), ".code-shell", "im-gateway", "desktop-control.json"),
    legacyDesktopGatewayLockPath: imGatewayService.configuredGatewayLockPath(),
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
  });
  // Delivery results settle the notices that made them; retry copies the
  // outbox appends get the same direct hand-off as a fresh publication.
  const controlServer = gatewayControlServer;
  controlServer.onEventResult((result) => void petNotices?.outboxResult(result));
  controlServer.onEventAppended((event) => handOffDirectDelivery(controlServer, event));
  await gatewayControlServer
    .start()
    // Notices recovered before the outbox could answer are settled now.
    .then(() => void petNotices?.outboxReady())
    .catch((error) => {
      dlog("main", "im_gateway.desktop_control.start_failed", { error: String(error) });
    });

  // A configured Chat Gateway is part of the Desktop runtime, not a panel
  // toggle. Start it on every owning app launch after the authenticated local
  // control server is ready, so targeted Mimi completion receipts can flow
  // even when the Link page is never opened. Invalid/fresh configs are a safe
  // no-op; adapter/login failures are surfaced in status and logs without
  // preventing the main window from opening.
  await imGatewayService.startConfiguredAtLaunch().catch((error) => {
    dlog("main", "im_gateway.autostart_failed", { error: String(error) });
  });

  const staleQuickChats = await runOwnedQuickChatStartupCleanup(
    ownsDesktopInstance,
    cleanupStaleQuickChatSessions,
  ).catch((error) => {
    dlog("main", "quick_chat.startup_cleanup_failed", { error: String(error) });
    return [];
  });
  if (staleQuickChats.length > 0) {
    dlog("main", "quick_chat.startup_cleanup_done", { sessionIds: staleQuickChats });
  }

  await injectLoginShellPathAtStartup({
    log: (event, data) => dlog("main", event, data),
  });

  // Child tools inherit appended fallbacks; existing and project PATHs keep precedence.
  await injectDesktopManagedRuntimePath({
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    appPath: app.getAppPath(),
    additionalDirectories: [join(app.getPath("userData"), "bin")],
  })
    .then((result) => dlog("main", "managed-runtime-path.ready", result))
    .catch((error) => dlog("main", "managed-runtime-path.failed", { error: String(error) }));

  // Main owns Electron safeStorage. Worker gets metadata snapshots and asks
  // main to resolve/materialize secrets on demand; if safeStorage is unavailable
  // SafeStorageCipher intentionally falls back to `plain:` owner-only storage.
  setDefaultCredentialCipher(new SafeStorageCipher());
  // Retired Link grants must resume cleanup even if no credentials page is opened.
  const linkCleanup = createLinkService();
  app.once("will-quit", () => linkCleanup.close());
  void knownAttachmentCwds()
    .then((cwds) => migrateKnownCredentialStores(cwds))
    .then((result) => dlog("credentials", "migration.done", { ...result }))
    .catch((err) => dlog("credentials", "migration.failed", { error: String(err) }));

  if (process.platform === "darwin" && app.dock) {
    try {
      app.dock.setIcon(resolve(__dirname, "..", "..", "build", "icon.png"));
    } catch {
      // dev-only nicety; ignore if the asset is missing in some build paths
    }
  }
  // Prime the workspace-trust cache so the agent-bridge's synchronous
  // agent/run handler can resolve project trust without a disk read. Until it
  // resolves, unknown → fail-closed (untrusted), which is the safe default.
  void warmTrustCache()
    .then(() => panelAppBridge.initializeMedia())
    .catch((error) => dlog("main", "panel.media.recovery.failed", { error: String(error) }));
  // Share the restorer with `activate`: a Dock click queued during a blocked
  // startup would otherwise open a second main window before this one registers.
  const initialWindowReady = restoreMainWindow();
  initUpdater();
  sweepStaleLeases(); // clear any cookie-lease temp files left by a prior crash
  sweepStaleCredentialCookies(); // clear UseCredential temp cookies.txt left by a prior crash

  // First-run defaults: copy bundled agents + register seed marketplace
  // sources into ~/.code-shell, THEN soft pre-install the core plugins
  // (skill-creator from mimi-plugins; feedback#22 决策). Chained because the
  // install needs the seeded marketplace registered first. best-effort,
  // fully self-guarded — never blocks the startup chain. Apply the git.path
  // override FIRST so the bootstrap clone honors a configured git binary.
  void applyGitPathFromSettings()
    .then(() => seedDefaults())
    .then(() => bootstrapCorePlugins());

  // Automation: load the in-process scheduler (read-only jobs). Persisted
  // jobs are restored from ~/.code-shell/cron.json. Cron follows the app
  // lifecycle by design (docs/automation-plan-2026-05-31.md, D2).
  try {
    // Recover Mimi's ledger and initialize dispatch before restored timers can fire.
    await initialWindowReady;
    // Feed in-main automation Engine events into the bridge's per-session
    // snapshot + renderer stream, so automation sessions reconnect identically
    // to interactive chat. `bridge?.` safely no-ops if a job somehow fires
    // before any window (and thus the bridge) exists.
    const emitAutomationEvent = (sessionId: string, event: unknown) => {
      bridge?.ingestExternalEvent(sessionId, event, { browserVisibility: "hidden" });
      if ((event as { type?: string })?.type === "run_result") {
        taskInboxAutomationSessions.delete(sessionId);
        taskInboxService?.scheduleRefresh();
      }
    };
    const announceAutomationSession = (meta: {
      sessionId: string;
      cwd: string;
      title: string;
      prompt: string;
      cronJobId: string;
      clientMessageId?: string;
    }) => {
      taskInboxAutomationSessions.set(meta.sessionId, meta.cronJobId);
      bridge?.broadcastAutomationSession(meta);
      taskInboxService?.scheduleRefresh();
    };
    // Each fired job runs as a one-shot read-only headless Engine, which
    // auto-writes a full transcript.jsonl (like interactive chat). The emit
    // callback streams events to a live snapshot for renderer reconnect; the
    // announce callback fires once with cwd+title so the renderer can place
    // the live run in the right project sidebar group immediately.
    const headlessAutomationRunner = buildDesktopAutomationRunner(
      emitAutomationEvent,
      announceAutomationSession,
    );
    // "Continue this conversation" jobs feed their prompt into the live session.
    const injectResumeTurn = createAutomationResumeTurn({
      bridge: () => bridge,
      notifyMissingTarget: (job) =>
        desktopNotifications.notifyMissingAutomationResumeTarget(desktopNotifier, job),
    });
    const automationRunner = makeCronRunnerWithResume(
      headlessAutomationRunner,
      injectResumeTurn,
      (job) => resolveDesktopAutomationJobWorkspace(job),
    );
    automationHandle = startAutomation({
      store: new CronStore(defaultCronStorePath()),
      runner: async (request) => {
        if (!isPetRuleScheduleJob(request.job)) return automationRunner(request);
        if (!petRuleScheduler)
          return {
            text: "Mimi 跟进服务不可用",
            reason: "unavailable",
            stop: { reason: "Mimi 跟进服务不可用" },
          };
        await petRuleScheduler.wake(request.job);
        return { text: "Scheduled rule wake handled", reason: "done" };
      },
      onJobEvent: (event) => {
        if (isPetRuleScheduleJob(event.job)) {
          if (event.type === "job_missed")
            void petRuleScheduler
              ?.missed(event.job)
              .catch((error) =>
                dlog("main", "pet.followUp.missed.failed", { error: String(error) }),
              );
          if (event.type === "job_error") petRuleScheduler?.repairSoon();
          return;
        }
        if (event.type !== "job_start") {
          for (const [sessionId, jobId] of taskInboxAutomationSessions) {
            if (jobId === event.job.id) taskInboxAutomationSessions.delete(sessionId);
          }
        }
        taskInboxService?.scheduleRefresh();
        const notification = automationLifecycleNotification(event);
        if (!notification) return;
        publishGatewayControlEventBestEffort(notification);
        desktopNotifications.notifyMissedAutomation(desktopNotifier, notification, event);
      },
    });
    // Expose the live scheduler to the automation IPC service (Phase 3 UI).
    setAutomationScheduler(automationHandle.scheduler);
    await petRuleScheduler?.start();
    // startAutomation installed the default executor (bindCronToEngine):
    // every cron job runs one headless codeshell turn. Driving Claude Code is
    // just one such turn calling DriveClaudeCode — no CC-specific scheduling.

    agentNotificationBus.subscribe((envelope) =>
      desktopNotifications.notifyBackgroundResult(desktopNotifier, envelope),
    );
  } catch (err) {
    // Automation is non-critical to the GUI — never block startup on it.
    console.error("automation: failed to start", err);
  }

  taskInboxDisposers.push(
    agentNotificationBus.subscribe(() => taskInboxService?.scheduleRefresh()),
  );
  taskInboxService?.start();

  // Defer initial sweep so the renderer has a chance to push current
  // git prefs via `git:setPrefs` first. Subsequent sweeps run hourly.
  setTimeout(() => void sweepStaleWorktrees("startup"), 5_000);
  setInterval(() => void sweepStaleWorktrees("interval"), 60 * 60_000);
});

ipcMain.handle(
  "skills:list",
  async (_e, target: RendererConfigurationTarget | null, opts?: { includeDisabled?: boolean }) =>
    listSkills(await rendererOptionalConfigurationCwd(target, resolveNoRepoCwd()), {
      includeDisabled: opts?.includeDisabled === true,
    }),
);
ipcMain.handle("capabilities:list", async (_e, target: RendererConfigurationTarget | null) =>
  listCapabilities(await rendererOptionalConfigurationCwd(target, "")),
);
ipcMain.handle(
  "capabilities:setEnabled",
  async (
    _e,
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
    const resolvedCwd = await rendererOptionalConfigurationCwd(target, "");
    if (typeof id !== "string") throw new Error("capabilities:setEnabled requires id");
    setCapabilityEnabled(resolvedCwd, id, Boolean(on), { scope });
  },
);
ipcMain.handle(
  "capabilities:setOverride",
  async (_e, target: RendererConfigurationTarget, id: string, state: "inherit" | "on" | "off") => {
    const cwd = await rendererConfigurationCwd(target);
    if (typeof id !== "string") throw new Error("capabilities:setOverride requires id");
    if (state !== "inherit" && state !== "on" && state !== "off")
      throw new Error("capabilities:setOverride requires state inherit|on|off");
    setCapabilityOverride(cwd, id, state);
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
ipcMain.handle("sources:catalogList", async () => listSourceCatalog());
ipcMain.handle("sources:catalogSave", async (_e, definition: unknown) => {
  if (typeof definition !== "object" || definition === null || Array.isArray(definition)) {
    throw new Error("sources:catalogSave requires definition");
  }
  saveSourceCatalog(definition as Parameters<typeof saveSourceCatalog>[0]);
});
ipcMain.handle("sources:catalogDelete", async (_e, id: string) => {
  if (typeof id !== "string" || !id) throw new Error("sources:catalogDelete requires id");
  deleteSourceCatalog(id);
});
ipcMain.handle("sources:projectAccess", async (_e, projectId: string) => {
  const { path } = await requireRendererProjectPrimary(projectId);
  return workspaceSourceAccess(path);
});
ipcMain.handle("sources:bindProject", async (_e, projectId: string, binding: unknown) => {
  const { path } = await requireRendererProjectPrimary(projectId);
  if (typeof binding !== "object" || binding === null || Array.isArray(binding)) {
    throw new Error("sources:bindProject requires binding");
  }
  bindSource(path, binding as Parameters<typeof bindSource>[1]);
});
ipcMain.handle("sources:unbindProject", async (_e, projectId: string, sourceId: string) => {
  const { path } = await requireRendererProjectPrimary(projectId);
  if (typeof sourceId !== "string" || !sourceId) {
    throw new Error("sources:unbindProject requires sourceId");
  }
  unbindSource(path, sourceId);
});
ipcMain.handle("sources:listScopes", async (_e, sourceId: string) => {
  if (typeof sourceId !== "string" || !sourceId) {
    throw new Error("sources:listScopes requires sourceId");
  }
  return listSourceScopes(sourceId);
});
ipcMain.handle("sources:pickAndUploadProject", async (_e, projectId: string) => {
  const { path } = await requireRendererProjectPrimary(projectId);
  const result = await dialog.showOpenDialog({
    title: "选择数据源文件",
    properties: ["openFile", "multiSelections"],
  });
  if (result.canceled || result.filePaths.length === 0) return [];
  return uploadFiles(path, result.filePaths);
});
ipcMain.handle("sources:deleteProjectUpload", async (_e, projectId: string, name: string) => {
  const { path } = await requireRendererProjectPrimary(projectId);
  if (typeof name !== "string" || !name) {
    throw new Error("sources:deleteProjectUpload requires name");
  }
  deleteUpload(path, name);
});
registerProfileSwitchIpc({
  ipcMain,
  resolveTarget: resolveRendererConfigurationTarget,
  withMutation: (cwd, write) => {
    if (!bridge) throw new Error("桌面运行时尚未就绪，请稍后重试。");
    return bridge.withWebConfigurationMutation(cwd, write);
  },
});
registerProfileCatalogIpc();
ipcMain.handle("plugins:list", async (_e, target: RendererConfigurationTarget | null) =>
  listPlugins(await rendererOptionalConfigurationCwd(target, "")),
);
ipcMain.handle("plugins:media", async (_e, installKey: string, includeScreenshots?: boolean) => {
  if (typeof installKey !== "string" || !installKey) {
    throw new Error("plugins:media requires installKey");
  }
  if (includeScreenshots !== undefined && typeof includeScreenshots !== "boolean") {
    throw new Error("plugins:media includeScreenshots must be boolean");
  }
  return getPluginMedia(installKey, includeScreenshots === true);
});
ipcMain.handle("plugin-commands:list", async (_e, target: RendererConfigurationTarget) =>
  listPluginCommands(await rendererConfigurationCwd(target)),
);
ipcMain.handle(
  "plugin-commands:expand",
  async (_e, target: RendererConfigurationTarget, name: string, rawArguments: string) => {
    const cwd = await rendererConfigurationCwd(target);
    if (typeof name !== "string" || !name || name.length > 512) {
      throw new Error("plugin-commands:expand requires name");
    }
    if (typeof rawArguments !== "string" || rawArguments.length > 512 * 1024) {
      throw new Error("plugin-commands:expand requires rawArguments");
    }
    return expandPluginCommand(cwd, name, rawArguments);
  },
);
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
    chromeNativeRegistration: () => chromeNativeRegistration,
  });
ipcMain.handle("plugins:detail", async (_e, installKey: string) => {
  if (typeof installKey !== "string" || !installKey) {
    throw new Error("plugins:detail requires installKey");
  }
  return getPluginDetail(installKey);
});
ipcMain.handle(
  "plugins:createAutomationFromTemplate",
  async (_e, installKey: string, templateId: string, expectedRevision: string, cwd?: string) => {
    if (
      typeof installKey !== "string" ||
      typeof templateId !== "string" ||
      typeof expectedRevision !== "string"
    ) {
      throw new Error("installKey, templateId and expectedRevision are required");
    }
    if (installKey.length > 512 || templateId.length > 512 || expectedRevision.length > 512) {
      throw new Error("plugin automation identifiers are too long");
    }
    return createAutomationFromPluginTemplate(
      installKey,
      templateId,
      expectedRevision,
      { cwd },
      desktopAutomationAuthorityDeps(),
    );
  },
);
ipcMain.handle("plugins:uninstall", async (_e, pluginName: string, marketplaceName: string) => {
  const result = await uninstallPluginEntry(pluginName, marketplaceName);
  broadcastPluginCommandsChanged(mainWindows);
  return result;
});
ipcMain.handle("plugins:uninstallLocal", async (_e, name: string) => {
  const result = await uninstallLocalPluginEntry(name);
  broadcastPluginCommandsChanged(mainWindows);
  return result;
});
ipcMain.handle("plugins:update", async (_e, installKey: string) => {
  const result = await updatePluginEntry(installKey);
  broadcastPluginCommandsChanged(mainWindows);
  return result;
});
ipcMain.handle("plugins:checkUpdate", async (_e, name: string) => {
  return checkPluginUpdateEntry(name);
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
ipcMain.handle("marketplace:list", async () => listMarketplacesForUi());
ipcMain.handle("marketplace:load", async (_e, name: string) => loadMarketplaceForUi(name));
ipcMain.handle("marketplace:recommended", async () => listRecommendedMarketplacesForUi());
ipcMain.handle("marketplace:add", async (_e, input: string) => addMarketplaceFromInput(input));
ipcMain.handle("marketplace:addRecommended", async (_e, id: string) =>
  addRecommendedMarketplaceForUi(id),
);
ipcMain.handle("marketplace:remove", async (_e, name: string) => removeMarketplaceForUi(name));
ipcMain.handle("marketplace:refresh", async (_e, name: string) => refreshMarketplaceForUi(name));
ipcMain.handle("plugins:installJobs", async () => listPluginInstallJobsForUi());
ipcMain.handle("plugins:install", async (_e, pluginName: string, marketplaceName: string) =>
  installPluginForUi(pluginName, marketplaceName),
);
ipcMain.handle("plugins:retryInstallJob", async (_e, id: string) => retryPluginInstallJobForUi(id));
ipcMain.handle("plugins:previewLocal", async (_e, input: { kind: "dir" | "zip"; path: string }) =>
  previewLocalPluginForUi(input),
);
ipcMain.handle(
  "plugins:installLocal",
  async (
    _e,
    input: {
      kind: "dir" | "zip";
      path: string;
      reviewToken: string;
      overwrite?: boolean;
    },
  ) => {
    const result = await installLocalPluginForUi(input);
    if (result.ok) broadcastPluginCommandsChanged(mainWindows);
    return result;
  },
);
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
ipcMain.handle(
  "skills:read",
  async (_e, target: RendererConfigurationTarget | null, filePath: unknown) =>
    readSkillBody(await requireRendererListedSkillPath(target, filePath)),
);
ipcMain.handle(
  "skills:checkUpdate",
  async (_e, target: RendererConfigurationTarget | null, filePath: unknown) =>
    checkSkillUpdateEntry(await requireRendererListedSkillPath(target, filePath)),
);
ipcMain.handle(
  "skills:update",
  async (_e, target: RendererConfigurationTarget | null, filePath: unknown) =>
    updateSkillEntry(await requireRendererListedSkillPath(target, filePath)),
);
const rendererProjectFileSearch = createRendererProjectFileSearch({
  requireProject: requireRendererProject,
  requireRoot: requireRendererProjectRoot,
});
ipcMain.handle("files:searchProject", (_e, projectId: unknown, query: unknown, rootId?: unknown) =>
  rendererProjectFileSearch(projectId, query, rootId),
);
ipcMain.handle("session:content-search", async (_e, ...args: unknown[]) => {
  const query = args.length === 1 ? args[0] : undefined;
  if (typeof query !== "string") throw new Error("invalid content search query");
  const trimmed = query.trim();
  if (trimmed.length < 2 || trimmed.length > 128) throw new Error("invalid content search query");
  return searchSessionTranscripts(sessionsRoot(), trimmed, { budgetMs: 5_000 });
});

registerAttachmentsIpc({ quickChatOwnership, deleteDesktopSession, assertQuickChatClaim });
ipcMain.handle(
  "skills:uninstall",
  async (
    _e,
    input: {
      scope?: unknown;
      target?: unknown;
      skillName?: unknown;
    },
  ) => {
    if (!input || typeof input !== "object") {
      throw new Error("skills:uninstall requires { scope, target, skillName }");
    }
    rejectUnexpectedRendererKeys(
      input as Record<string, unknown>,
      ["scope", "target", "skillName"],
      "skills:uninstall",
    );
    const scope = input.scope === "user" || input.scope === "project" ? input.scope : null;
    if (!scope) throw new Error("invalid scope");
    if (typeof input.skillName !== "string") {
      throw new Error("skills:uninstall requires skillName");
    }
    if (scope === "project" && input.target == null) {
      throw new Error("project skill uninstall requires stable authority");
    }
    if (scope === "user" && input.target != null) {
      throw new Error("user skill uninstall does not accept project authority");
    }
    const authorizedCwd =
      input.target == null
        ? undefined
        : await rendererConfigurationCwd(input.target as RendererConfigurationTarget);
    return uninstallSkill({
      scope,
      cwd: authorizedCwd,
      skillName: input.skillName,
    });
  },
);
registerAgentsMediaIpc({ mainWindows, mediaPreviewService });
registerSkillsMcpIpc({ getMcpOAuthService });
// Read-only list of plugin-provided hooks, for the settings 钩子 page to show
// alongside hand-written hooks (labelled by owner plugin). Mirrors
// mcp:listMerged's disabledPlugins handling. (#钩子设置页改造)
ipcMain.handle("hooks:listPlugin", async (_e, rawDisabledPlugins?: unknown) => {
  const disabledPlugins = Array.isArray(rawDisabledPlugins)
    ? rawDisabledPlugins.filter((x): x is string => typeof x === "string")
    : [];
  return listPluginHooks(disabledPlugins);
});
ipcMain.handle("hooks:approvePlugin", async (_e, installKey: string) => {
  if (typeof installKey !== "string" || !installKey) {
    throw new Error("hooks:approvePlugin requires installKey");
  }
  return approvePluginHooks(installKey);
});
ipcMain.handle("hooks:revokePlugin", async (_e, installKey: string) => {
  if (typeof installKey !== "string" || !installKey) {
    throw new Error("hooks:revokePlugin requires installKey");
  }
  return revokePluginHooks(installKey);
});
ipcMain.handle("mcp:listPluginTrust", async () => listPluginMcpTrust());
ipcMain.handle("mcp:approvePlugin", async (_e, installKey: string) => {
  if (typeof installKey !== "string" || !installKey) {
    throw new Error("mcp:approvePlugin requires installKey");
  }
  return approvePluginMcp(installKey);
});
ipcMain.handle("mcp:revokePlugin", async (_e, installKey: string) => {
  if (typeof installKey !== "string" || !installKey) {
    throw new Error("mcp:revokePlugin requires installKey");
  }
  return revokePluginMcp(installKey);
});

registerModelCatalogIpc();
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
} = registerMobileRemoteIpc({
  mobileDevices,
  mobileRemote,
  cloudflaredBinary,
  tunnelManager,
  accessPasscode,
  mobileRemoteController,
  mobileOrchestrator,
});
const knownGitRoots = new Set<string>();

registerProjectAuthorityIpc({
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
  getGitStatus,
  getGitBranches,
  revealInFinder,
  openPath,
});

registerRoomsIpc({
  mainWindows,
  bridge: () => bridge,
  approvalBridge,
  roomManager,
  transcriptSubscriptions,
  roomModes,
  mobileOrchestrator,
});
registerDialogPickerIpc();
ipcMain.handle("window:new", async () => {
  await createWindow();
});

ipcMain.handle("window:isFullscreen", async (e): Promise<boolean> => {
  return BrowserWindow.fromWebContents(e.sender)?.isFullScreen() ?? false;
});

registerWindowTitleBarIpc({ ipcMain, platform: process.platform, windows: () => mainWindows });

function isMainWindowSender(sender: Electron.WebContents): boolean {
  return [...mainWindows].some((window) => !window.isDestroyed() && window.webContents === sender);
}

// Every Mimi entry — account menu, Mimi settings, legacy widget/companion IPC
// and both surfaces' menus — goes through the one presence owner.
registerMimiPresenceIpc({
  ipcMain,
  owner: mimiPresenceOwner,
  isMainWindow: isMainWindowSender,
  isDockedSurface: (sender) => Boolean(petWidgetSurface?.owns(sender.id)),
});

ipcMain.on("pet:widget-context-menu", (event) => {
  const win = petWidgetWindow();
  if (!win || win.isDestroyed() || event.sender !== win.webContents) return;
  const presence = mimiPresenceOwner.snapshot();
  const input = getComputerUseInputControl();
  const inputStatus = input?.status();
  const template = petWidgetMenuTemplate({
    locale: app.getLocale(),
    movingAvailable: presence.movingAvailable,
    movingUnavailableReason: presence.movingUnavailableReason,
    computerInput:
      input && inputStatus
        ? { resume: inputStatus.stopped || inputStatus.foregroundHeld }
        : undefined,
    actions: {
      open: () => void openPetOverviewFromWidget(),
      switchToMoving: () => void mimiPresenceOwner.set({ mode: "moving" }),
      stopOrResumeComputer: (resume) => {
        if (resume) input?.resume();
        else input?.stop();
        dlog("computer-use", resume ? "computer_input_resumed" : "computer_input_stopped", {
          source: "docked-mimi",
        });
      },
      close: () => void mimiPresenceOwner.set({ visible: false }),
    },
  });
  Menu.buildFromTemplate(template).popup({ window: win });
});

ipcMain.on("pet:widget-move", (event, rawPosition: unknown) => {
  if (!petWidgetSurface?.owns(event.sender.id)) return;
  petWidgetSurface.moveTo(rawPosition);
});

ipcMain.handle("pet:widget-expanded", (event, expanded: unknown) => {
  if (typeof expanded !== "boolean") throw new Error("pet:widget-expanded requires boolean");
  if (petWidgetSurface?.owns(event.sender.id)) {
    petWidgetSurface.setSurfaceMode(expanded ? "expanded" : "collapsed");
  } else if (mimiBubble?.surface.owns(event.sender.id)) mimiBubble.surface.setExpanded(expanded);
  return { ok: true as const };
});

ipcMain.handle("pet:widget-surface", (event, mode: unknown) => {
  if (mode !== "collapsed" && mode !== "expanded") {
    throw new Error("pet:widget-surface requires collapsed or expanded");
  }
  if (petWidgetSurface?.owns(event.sender.id)) {
    petWidgetSurface.setSurfaceMode(mode);
  } else if (mimiBubble?.surface.owns(event.sender.id)) {
    mimiBubble.surface.setExpanded(mode === "expanded");
  }
  return { ok: true as const };
});

ipcMain.handle("pet:widget-open-overview", async (_event, request?: unknown) => {
  await openPetOverviewFromWidget(request);
  return { ok: true as const };
});

// Open the standalone browser popout, parented to the requesting window so its
// element-pick anchors route back to that window's composer.
ipcMain.handle("browser:popout", async (e, initialUrl?: string) => {
  const parent = BrowserWindow.fromWebContents(e.sender);
  if (!parent || !mainWindows.has(parent)) return;
  let normalizedUrl: string | undefined;
  if (initialUrl !== undefined) {
    if (typeof initialUrl !== "string" || initialUrl.length > 8_192 || initialUrl.includes("\0")) {
      throw new Error("invalid browser popout URL");
    }
    const parsed = new URL(initialUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("browser popout URL must use HTTP or HTTPS");
    }
    normalizedUrl = parsed.toString();
  }
  await createBrowserPopout(parent, normalizedUrl);
});

const { externalRuntimeModelService } = registerExternalRuntimeIpc({
  externalRuntimeService: () => externalRuntime.service,
  externalRuntimeApprovals: () => externalRuntime.approvals,
});
registerBrowserPopoutIpc({ mainWindows, popoutParents, browserAnchorsByParent });
const { sweepStaleWorktrees } = registerGitReviewIpc({ knownGitRoots });
registerWorkspaceFilesIpc({ appRendererNavigation, mainWindows, assertRendererSessionAccess });
// Authoritative no-repo conversation cwd (~/.code-shell/no-repo). The renderer
// is a thin client and must NOT recompute homedir() itself; it asks main so the
// path it writes capabilityOverrides to is byte-identical to the worker cwd.
ipcMain.handle("no-repo:cwd", async () => resolveNoRepoCwd());

ipcMain.handle("settings:get", async (_e, scope: SettingsScope) => {
  if (scope !== "user") throw new Error("settings:get is user-scoped");
  return readSettings("user");
});
ipcMain.handle("settings:getConfiguration", async (_e, target: RendererConfigurationTarget) =>
  readSettings("project", await rendererConfigurationCwd(target)),
);

function validateRendererSettingsPatch(patch: Record<string, unknown>): void {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    throw new Error("patch must be object");
  }
  if (["panelAppBindings", "panelAppPins", "panelAppOverrides"].some((key) => key in patch)) {
    throw new Error("Panel project bindings must use the reviewed project binding API");
  }
  try {
    if (Buffer.byteLength(JSON.stringify(patch)) > 2 * 1024 * 1024) {
      throw new Error("settings patch is too large");
    }
  } catch (error) {
    if (error instanceof Error && error.message === "settings patch is too large") throw error;
    throw new Error("settings patch must be JSON-serializable", { cause: error });
  }
}

async function applyRendererSettingsSideEffects(
  scope: SettingsScope,
  patch: Record<string, unknown>,
): Promise<void> {
  const touchesPanelApps =
    "disabledPanelApps" in patch || "panelAppBindings" in patch || "panelAppOverrides" in patch;
  // Before any await: a failing side effect must not leave the guard on the old binding.
  if (touchesPanelApps) invalidatePanelAppBindingGuard();
  if ("git" in patch) void applyGitPathFromSettings();
  if (scope === "user" && "pet" in patch) petNotices?.settingsChanged();
  if (touchesExternalSessionVisibility(scope, patch)) await reconcileExternalAdapters?.();
  if (touchesPanelApps) {
    broadcastPanelAppsChanged(mainWindows);
  }
  if ("disabledPlugins" in patch || "capabilityOverrides" in patch) {
    broadcastPluginCommandsChanged(mainWindows);
  }
}

ipcMain.handle("settings:set", async (_e, scope: SettingsScope, patch: Record<string, unknown>) => {
  if (scope !== "user") throw new Error("settings:set is user-scoped");
  validateRendererSettingsPatch(patch);
  await writeSettings("user", patch);
  await applyRendererSettingsSideEffects("user", patch);
});
ipcMain.handle(
  "settings:setConfiguration",
  async (_e, target: RendererConfigurationTarget, patch: Record<string, unknown>) => {
    validateRendererSettingsPatch(patch);
    const path = await rendererConfigurationCwd(target);
    await writeSettings("project", patch, path);
    await applyRendererSettingsSideEffects("project", patch);
  },
);

registerMemoryIpc({ mainWindows });
async function deleteDesktopSession(id: string): Promise<void> {
  deletingBrowserSessions.add(id);
  rendererBrowserSessionAccess.forgetSession(id);
  try {
    await deleteDesktopSessionResources(id);
  } finally {
    // Invalidate any authorization captured before deletion started, including
    // in-flight durable reads, before allowing this ID to be opened again.
    rendererBrowserSessionAccess.forgetSession(id);
    deletingBrowserSessions.delete(id);
  }
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
  removeExternalRuntimeBinding(id);
  await deleteSession(id);
  await cleanupKnownAttachments(id);
  // Drop any in-memory snapshot for the deleted session so it can't be
  // replayed into a fresh tab that happens to reuse the id.
  bridge?.forgetSession(id);
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
  pendingMobileApprovals.forgetSession(id);
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

ipcMain.handle("agent:pendingApprovals", (event) => {
  // Native approval events already reach all main windows. Preserve that queue
  // and its session envelopes, without replaying resolved historical requests.
  pendingMobileApprovals.setWorkerState(
    bridge?.workerGeneration() ?? 0,
    bridge?.hasLiveWorker() ?? false,
  );
  return [
    ...pendingMobileApprovals.replayAllLines().map((line) => JSON.parse(line).params),
    ...(externalRuntime.approvals?.pendingForWindow(event.sender.id) ?? []),
  ];
});
/**
 * Snapshot subscription: a (re)mounted renderer asks main for the events it
 * missed for a session past `sinceSeq`. main holds these (AgentBridge's
 * SessionSnapshotStore) precisely because it does not remount with the
 * renderer. Returns { events: [{seq,event}], nextSeq }.
 */
ipcMain.handle("agent:subscribe", async (_e, sessionId: string, sinceSeq?: number) => {
  assertDesktopSessionId(sessionId);
  const cursor =
    typeof sinceSeq === "number" && Number.isSafeInteger(sinceSeq) && sinceSeq >= 0 ? sinceSeq : 0;
  return (
    bridge?.getSnapshot(sessionId, cursor) ?? {
      events: [],
      nextSeq: 1,
      topLevelRunning: false,
    }
  );
});
let closeActivityHistory: (() => Promise<void>) | undefined;
registerDesktopOutputHistoryHost({
  ipcMain,
  windows: () => [...mainWindows],
  historyWindows: () => {
    return [...mainWindows, ...petSurfaceWindows()];
  },
  bridge: () => bridge,
  external: () => externalRuntime.service,
  mobile: mobileOrchestrator,
  registerCleanup: (cleanup) => {
    closeActivityHistory = cleanup;
  },
});
const sessionCatalogStore = new SessionCatalogStore();
const sessionCatalogIpc = registerSessionCatalogIpc(
  ipcMain,
  () => {
    return [...mainWindows, ...petSurfaceWindows()];
  },
  sessionCatalogStore,
);
function taskInboxEnabled(): boolean {
  const settings = new SettingsManager(resolveNoRepoCwd(), "full").getForScope("user");
  return settings.featureFlags?.taskInboxV1 !== false;
}
taskInboxDisposers.push(
  registerOptimizationLabHost({
    windows: () => [...mainWindows],
    settingsCwd: resolveNoRepoCwd,
    resolveTarget: resolveRendererConfigurationTarget,
    trust: getTrust,
    bridge: () => bridge,
  }),
);
const taskInboxSources = createTaskInboxSources({
  diskSessions: () => listAllDiskSessions({ includeSubagents: true }),
  sessionCatalog: () => sessionCatalogStore.load(),
  sessionProjection: () => petStateAggregator?.getSnapshot(),
  native: {
    hasLiveWorker: () => !!bridge?.hasLiveWorker() || taskInboxAutomationSessions.size > 0,
    isSessionRunning: (id) => taskInboxAutomationSessions.has(id) || !!bridge?.isSessionRunning(id),
    cancel: async (id) => {
      const jobId = taskInboxAutomationSessions.get(id);
      if (jobId) return cancelAutomationRun(jobId);
      if (!bridge?.hasLiveWorker() || !bridge.isSessionRunning(id)) return false;
      const result = await bridge.requestWorker("agent/cancel", { sessionId: id }, 15_000, {
        failFast: true,
        settleOnExit: true,
        meta: { origin: "host", producer: "task-inbox" },
      });
      if (!result.ok) throw new Error(result.message);
      return true;
    },
  },
  runs: { list: listRuns },
  automations: {
    list: listAutomations,
    get: getAutomation,
    pause: pauseAutomation,
    resume: resumeAutomation,
    runNow: runAutomationNow,
  },
  mimi: {
    snapshot: () => {
      if (!petLongTaskStore) throw new Error("Delegation ledger is not ready");
      return petLongTaskStore.getSnapshot();
    },
    get: (id) => petLongTaskStore?.get(id),
    control: async (request) => {
      if (!petLongTaskCoordinator) throw new Error("Delegation controller is not ready");
      return petLongTaskCoordinator.control(request);
    },
  },
  external: {
    hasSession: (id) => !!externalRuntime.service?.hasSession(id),
    isSessionRunning: (id) => !!externalRuntime.service?.isSessionRunning(id),
    hasPending: (id) => !!externalRuntime.approvals?.hasPendingSession(id),
    kind: (id) => readExternalRuntimeBinding(id)?.kind,
    interrupt: async (id) => {
      if (!externalRuntime.service?.hasSession(id))
        throw new Error("External runtime is unavailable");
      await externalRuntime.service.interrupt(id);
    },
  },
  background: createTaskInboxBackgroundHost({ worker: () => bridge }),
});
const taskInboxService = createTaskInboxService({
  filePath: resolve(app.getPath("userData"), "task-inbox", "v1.json"),
  ...taskInboxSources,
  enabled: taskInboxEnabled,
  onError: (error) => dlog("main", "task-inbox.projection.failed", { error: String(error) }),
});
taskInboxDisposers.push(
  registerTaskInboxIpc(ipcMain, () => [...mainWindows], taskInboxService, taskInboxEnabled),
  sessionCatalogStore.onChanged(() => taskInboxService?.scheduleRefresh()),
);
backgroundWork.registerBackgroundWorkIpc(ipcMain, mainWindows, () => bridge);
const disposeOperationBatchHost = registerOperationBatchHost({
  windows: () => [...mainWindows],
  enabled: taskInboxEnabled,
  bridge: () => bridge ?? undefined,
  isSessionRunning: (id) =>
    taskInboxAutomationSessions.has(id) ||
    bridge?.isSessionRunning(id) === true ||
    externalRuntime.service?.isSessionRunning(id) === true,
});
const disposeOperationResolutionHost = registerOperationResolutionHost({
  windows: () => [...mainWindows],
  enabled: taskInboxEnabled,
  isSessionRunning: (id) =>
    taskInboxAutomationSessions.has(id) ||
    !!bridge?.isSessionRunning(id) ||
    !!externalRuntime.service?.isSessionRunning(id),
});
registerAutomationIpc();
registerTrustNotificationIpc({ externalRuntimeService: () => externalRuntime.service });
registerDesktopShutdown(app, {
  ownsInstance: () => ownsDesktopInstance,
  flushRenderers: () => sessionCatalogIpc.flushRenderers(),
  disposeOperationResolution: async () => {
    await disposeOperationBatchHost();
    await disposeOperationResolutionHost();
  },
  onError: (phase, error) => dlog("main", phase, { error: String(error) }),
  cancelQuit: cancelPendingUpdateInstall,
  showFailureDialog: (options) => dialog.showMessageBox(options),
  restoreMainWindow,
  cleanup: async () => {
    cloudEnvironment.dispose();
    taskInboxService?.dispose();
    for (const dispose of taskInboxDisposers.splice(0)) dispose();
    const cookieRefreshShutdown = cookieCredentialAutoRefresh.shutdown();
    petRuntimeReady = false;
    browserRuntime.closeAll();
    bridge?.kill();
    petStateAggregator?.stop();
    petStateAggregator = null;
    petExternalVisibilityController?.shutdown();
    petExternalVisibilityController = null;
    reconcileExternalAdapters = null;
    petDispatchService = null;
    petRuleScheduler?.stop();
    petRuleScheduler = null;
    petHostActionReceiptService = null;
    petImDecisions?.stop();
    petImDecisions = null;
    petLongTaskCoordinator?.stop();
    petLongTaskCoordinator = null;
    unsubscribePetLongTaskStream?.();
    unsubscribePetLongTaskStream = null;
    unsubscribePetReportStream?.();
    unsubscribePetReportStream = null;
    const petNoticeFlush = petNotices?.flush();
    petNotices?.dispose();
    petNotices = null;
    const petWorkInboxFlush = petWorkInboxStore?.flush();
    petWorkInboxStore = null;
    const petLongTaskFlush = petLongTaskStore?.flush();
    petLongTaskStore = null;
    disposePetIpc?.();
    disposePetIpc = null;
    automationHandle?.stop();
    automationHandle = null;
    ptyKillAll();
    transcriptSubscriptions?.closeAll();
    roomManager.closeAll();
    // Stop captured external runtimes explicitly; their child processes can survive Windows exit.
    const externalRuntimeShutdown = desktopModules.dispose();
    // Stop the embedded Cua child explicitly.
    const cuaDriverShutdown = getCuaDriverHost()?.stop();
    // Withdraw both Mimi forms and persist presence before closing the character host.
    const mimiPresenceShutdown = mimiPresence?.dispose();
    petWidgetSurface?.dispose();
    mimiBubble?.surface.dispose();
    await Promise.allSettled([
      closeActivityHistory?.(),
      mimiPresenceShutdown,
      imGatewayService.dispose(),
      mobileRemoteController.dispose(),
      cloudManagementManager.dispose(),
      gatewayControlServer?.stop(),
      petWorkInboxFlush,
      petLongTaskFlush,
      petNoticeFlush,
      externalRuntimeShutdown,
      cookieRefreshShutdown,
      panelAppBridge.shutdownMedia(),
      chromeExtensionRuntimeService.stop(),
      cuaDriverShutdown,
      closeComputerUse(),
    ]);
    gatewayControlServer = undefined;
    await mobileUploads.dispose();
  },
  finalize: () => sessionCatalogIpc.close(),
});
