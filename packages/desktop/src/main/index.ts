/**
 * Electron main entry — broker between renderer (ipcMain) and the
 * agent worker subprocess (stdio JSON-RPC). See agent-bridge.ts.
 */

import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  session,
  shell,
  systemPreferences,
  webContents,
  Notification,
  screen,
  type OpenDialogOptions,
  type SaveDialogOptions,
} from "electron";
import { fileURLToPath } from "node:url";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { dirname, resolve, basename, extname, isAbsolute, join } from "node:path";
import { writeFile } from "node:fs/promises";
import {
  approvePluginHooks,
  approvePluginMcp,
  listPluginMcpTrust,
  mergePluginMcpServers,
  listPluginHooks,
  revokePluginMcp,
  revokePluginHooks,
  SettingsManager,
  writeSettingsSchemaFile,
  userHome,
  CredentialStore,
  materializeCookieSecret,
  type Credential,
  type CredentialScope,
  validateLocalLinkToken,
  connectCliLink,
  getCliLinkStatus,
  isCliLinkProvider,
  type CliLinkProviderId,
  sweepStaleCredentialCookies,
  setDefaultCredentialCipher,
  sessionsRoot,
  // Quota — remaining CC/Codex subscription usage.
  ErrorCodes,
  WORKSPACE_PROFILE_NAME_RE,
  previewLocalTheme,
  installReviewedLocalTheme,
  listInstalledThemes,
  uninstallTheme,
  type InstalledTheme,
  type GitPanelAppSourceInput,
  type PanelAppSourceInput,
  type ThemePreview,
} from "@cjhyy/code-shell-core";
import {
  defaultCacheDir,
  fetchModelList,
  PROVIDER_KINDS,
  reasoningControlFor,
  type ProviderKindName,
  startAutomation,
  CronStore,
  defaultCronStorePath,
  agentNotificationBus,
  backgroundJobRegistry,
  buildNotificationMessage,
  notificationQueue,
  type AutomationHandle,
  getMergedCatalog,
  saveCatalogEntry,
  deleteUserCatalogEntry,
  userCatalogPath,
  catalogEntryOrigins,
  setGitPathOverride,
  isGitAvailable,
  resolveGitPath,
  // Speech-to-text (voice input / 听写).
  transcribe,
  resolveTranscribeProvider,
  isTranscribeAvailable,
  describeTranscribe,
  computeEffectiveDisabledLists,
} from "@cjhyy/code-shell-core/internal";
import {
  CC_COST_GUARD_PROMPT,
  checkQuota,
  countRelatedSessions,
  DEFAULT_DISCOVER_LIMIT,
  DEFAULT_DISCOVER_SINCE_MS,
  discoverRecentClaudeSessions,
  discoverRecentCodexSessions,
  discoverRelatedSessions,
  parseClaudeTranscriptLine,
  parseCodexTranscriptLine,
  probeClaudeCli,
  probeCodexCli,
  readCodexRecentHistory,
  readRecentHistory,
  resolveQuotaCredentials,
  type ExternalSessionDiscoveryScope,
  type QuotaResult,
} from "@cjhyy/code-shell-capability-coding/orchestration";
import { normalizeWorktreeBranchPrefix } from "@cjhyy/code-shell-capability-coding/git";
import { AgentBridge, resolveNoRepoCwd } from "./agent-bridge.js";
import { externalRuntimeBrowserBucket } from "./external-runtime-browser-bucket.js";
import { ExternalRuntimeService } from "./external-runtime-service.js";
import { removeExternalRuntimeBinding } from "./external-runtime-state.js";
import {
  ExternalRuntimeApprovals,
  parseExternalApprovalDecision,
} from "./external-runtime-approvals.js";
import { availableExternalRuntimes } from "./external-runtime-availability.js";
import type { ExternalRuntimeAttachment } from "@cjhyy/code-shell-capability-coding/external-runtimes";
import { parseExternalRuntimeModelKey } from "../shared/external-runtime-models.js";
import {
  requireRendererProject,
  requireRendererProjectEntryPath,
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
import { PET_CHAT_EVENT_CHANNEL, registerPetIpc } from "./pet/pet-ipc.js";
import {
  completePetHostActionReceipt,
  PetHostActionReceiptService,
} from "./pet/pet-host-action-completion.js";
import { PetMetadataStore } from "./pet/pet-metadata-store.js";
import {
  formatPetLongTaskClosureMessage,
  PetDispatchService,
  type PetHostActionExecution,
} from "./pet/pet-dispatch-service.js";
import { enrichPetChatReplyWithHostActions } from "./pet/host-action-reply.js";
import { PetMemoryStore } from "./pet/pet-memory-store.js";
import { PetWorkDelegationHost } from "./pet/pet-work-delegation-host.js";
import { PetAttentionPolicy } from "./pet/pet-attention-policy.js";
import { PetReceiptStore } from "./pet/pet-receipt-store.js";
import { PetWorkInboxStore } from "./pet/pet-work-inbox-store.js";
import { PetHostActionReceiptStore } from "./pet/pet-host-action-receipts.js";
import { archivePetSessionsBySelector } from "./pet/pet-session-archive.js";
import { createPetFollowUpService } from "./pet/pet-follow-up-service.js";
import { PetWorkMemoryStore } from "./pet/pet-work-memory-store.js";
import { PetSegmentController, type PetArchiveAnchors } from "./pet/pet-segment-controller.js";
import { PetLongTaskStore } from "./pet/pet-long-task-store.js";
import { PetLongTaskCoordinator } from "./pet/pet-long-task-coordinator.js";
import { selectSessionsToArchive } from "./pet/pet-auto-archive.js";
import {
  openLinkedSessionFromIpc,
  takeOverLinkedSessionFromIpc,
} from "./cc-room/linked-session-ipc.js";
import { resolveLinkedSessionFromDisk } from "./cc-room/linked-session-resolver.js";
import { DEFAULT_SEGMENT_IDLE_MS, buildMigrationSummary } from "@cjhyy/code-shell-pet";
import { searchSessionTranscripts } from "@cjhyy/code-shell-pet/disclosure";
import { materializeOutgoingAttachments } from "@cjhyy/code-shell-chat";
import { createReusableSessionResolver } from "./pet/reusable-session-resolver.js";
import {
  petChatModelKeyFromSettings,
  petMemoryAutoExtractFromSettings,
  petMemoryAutoExtractSettingsPatch,
  petPersonalizationFromSettings,
} from "../shared/pet-settings.js";
import type { InstalledThemePack } from "../shared/theme-packs.js";
import { SafeStorageCipher } from "./credential-cipher.js";
import { McpOAuthService, type McpOAuthLoginInput } from "./mcp-oauth-service.js";
import { listDesktopLinkProviders } from "./link-provider-catalog.js";
import {
  isLocalBrowserLinkProvider,
  LinkDeviceOAuthBroker,
  type LocalBrowserAuthToken,
} from "./link-device-oauth.js";
import {
  installManagedLinkCli,
  managedCliInstallStatus,
  type ManagedCliInstallResult,
} from "./link-cli-installer.js";
import { migrateCredentialStore, migrateKnownCredentialStores } from "./credential-migration.js";
import { inspectReadableReplyAttachment, readImageDataUrl } from "./image-read-service.js";
import {
  bucketForSession,
  browserPartitionForBucket as registryPartitionForBucket,
  guestRecordForId,
  listGuestSessions,
  partitionForSession,
  rememberAttachedGuest,
  registerAttachedGuestMetadata,
  registerSessionBucket,
  sessionIdsForBucket,
} from "./browser-driver/active-guest.js";
import {
  browserRuntime,
  builtInBrowserHandoffGrants,
  chromeExtensionRuntimeService,
  installChromeNativeMessagingHost,
  interactiveBrowserBridgeForSession,
  interactiveBrowserRuntimeOwner,
  nativeMessagingOriginFromArgv,
  runChromeNativeMessagingHost,
  type ChromeNativeRegistrationResult,
} from "./browser-runtime/index.js";
import {
  buildDesktopAutomationRunner,
  makeCronRunnerWithResume,
  resolveDesktopAutomationJobWorkspace,
} from "./automation-host.js";
import { automationLifecycleNotification } from "./automation-notification.js";
import type { CronRunResult } from "@cjhyy/code-shell-core/internal";
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
  type UpdateAutomationInput,
} from "./automation-service.js";
import { desktopAutomationAuthorityDeps } from "./automation-authority.js";
import { dlog } from "./desktop-logger.js";
import {
  ptyStart,
  ptyWrite,
  ptyResize,
  ptyKill,
  ptyKillAll,
  ptyReapDestroyed,
  assertValidPtySessionId,
} from "./pty-service.js";
import {
  listCookieDomains,
  getCookiesForDomain,
  captureCookieJar,
  captureAllCookies,
  captureAllCookiesFromSessions,
  restoreCookiesToBrowser,
  cleanupLease,
  sweepStaleLeases,
  BROWSER_PARTITION,
  type ElectronCookieLike,
} from "./credentials-service.js";
import { loginAndCaptureCookies } from "./credentials-login/index.js";
import {
  archiveDiskSession,
  cleanupAttachments,
  cleanupSessionAttachments,
  cleanupStaleQuickChatSessions,
  deleteSession,
  listDiskSessions,
  listRecentAttachments,
  listSessions,
  markAttachmentsSent,
  stablePromptHash,
  stageFileBytes,
  stageImageBytes,
  stageImageDataUrl,
  type InputAttachmentMeta,
} from "@cjhyy/code-shell-server/storage";
import {
  AccessPasscode,
  CloudflaredBinary,
  CodexRoomAgent,
  MobileUploadService,
  mobileTranscriptSubscriberId,
  PendingMobileApprovals,
  RemoteHostManager,
  ResidentAgentProcess,
  RoomManager,
  TrustedDeviceStore,
  TunnelManager,
  type MobileViewerIdentity,
} from "@cjhyy/code-shell-server/mobile-remote";
import {
  MobileRemoteOrchestrator,
  injectAndAwaitResult,
  resolveRoomPermissionMode,
  type AuthenticatedMobileClientEvent,
} from "./mobile-remote-orchestrator.js";
import {
  GatewayControlServer,
  type GatewayControlEventAttachment,
  type GatewayControlEventInput,
  type MobileRemoteGatewayStatus,
  type MobileRemoteOpenResult,
  type PetChatControlRequest,
  type PetChatControlResult,
} from "./im-gateway-control-server.js";
import { ImGatewayService, registerImGatewayIpc } from "./im-gateway-service.js";
import { ApprovalBridge } from "./cc-room/approval-bridge.js";
import { TranscriptSubscriptionManager } from "./cc-room/transcript-subscriptions.js";
import { QuickChatOwnershipRegistry } from "./quick-chat-ownership.js";
import { readDirectory, readFile as fsReadFile, fileExists as fsFileExists } from "./fs-service.js";
import {
  getGitStatus,
  getGitBranches,
  switchGitBranch,
  stashAndSwitchGitBranch,
  cleanupStaleWorktrees,
  openExternal,
  revealInFinder,
  openPath,
  openInEditor,
  undoFiles,
  type UndoFilesResult,
  type StaleWorktreeCleanupSkipped,
} from "./desktop-services.js";
import { turnUndoState, undoTurn, redoTurn } from "./file-history-service.js";
import { readSettings, writeSettings, type SettingsScope } from "./settings-service.js";
import {
  listMemory,
  readMemory,
  saveMemory,
  deleteMemory,
  listPendingMemory,
  approvePendingMemory,
  demotePendingMemory,
  rejectPendingMemory,
  promoteMemoryToGlobal,
  type MemoryLevel,
  type SaveMemoryInput,
} from "./memory-service.js";
import { runDream } from "./dream-service.js";
import type { MemoryScope } from "@cjhyy/code-shell-core";
import { getSessionTranscript } from "./transcript-reader.js";
import { probeLocalhostPorts } from "./port-probe.js";
import { getSessionEvents } from "./rawTranscript.js";
import { listTitles, setTitle } from "./session-titles-store.js";
import { tailLog, type LogBucket } from "./logs-service.js";
import {
  installSkillFromDirectory,
  listSkills,
  readSkillBody,
  uninstallSkill,
} from "./skills-service.js";
import {
  listPlugins,
  getPluginDetail,
  uninstallPluginEntry,
  uninstallLocalPluginEntry,
  updatePluginEntry,
  checkPluginUpdateEntry,
} from "./plugins-service.js";
import {
  isPanelAppBoundToProject,
  listPanelAppExtensions,
  listPanelApps,
  listPanelAppsForProjects,
} from "./panel-apps-service.js";
import {
  discoverGitPanelAppsForUi,
  installPanelAppUpdateForUi,
  installLocalPanelAppForUi,
  previewPanelAppUpdateForUi,
  previewLocalPanelAppForUi,
  uninstallPanelAppForUi,
} from "./panel-app-install-service.js";
import { createAutomationFromPluginTemplate } from "./plugin-automation-service.js";
import { expandPluginCommand, listPluginCommands } from "./plugin-command-service.js";
import { getPluginMedia } from "./plugin-media-service.js";
import {
  preparedPanelAppPartitionProjectPath,
  registerPanelAppSchemePrivileges,
  validatePanelAppEntryUrl,
} from "./panel-app-protocol.js";
import { installThemeAssetProtocol, themeAssetUrl } from "./theme-asset-protocol.js";
import { PanelAppBridge } from "./panel-app-bridge.js";
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
import {
  activateProfile,
  addProfileRepo,
  deleteProfile,
  deactivateProfile,
  exportProfileDefinition,
  exportProfileRepo,
  forceDeleteProfile,
  importReviewedProfileDefinition,
  installCatalogProfile,
  installProfileRequirements,
  listProfileCatalog,
  listProfileRepos,
  listProfiles,
  previewProfileDefinitionImport,
  previewProfileDeletion,
  previewProfileRequirements,
  removeProfileRepo,
  saveProfile,
  setSessionWorkspaceProfile,
} from "./profiles-service.js";
import {
  deleteDigitalHumanTeam,
  listDigitalHumanTeams,
  saveDigitalHumanTeam,
} from "./digital-human-team-service.js";
import { searchProjectFiles } from "./file-search-service.js";
import { listAgents, readAgentBody, saveAgent, deleteAgent } from "./agents-service.js";
import type { AgentDefinition } from "@cjhyy/code-shell-core";
import {
  inspectRepo,
  installFromGithub,
  type InstallFromGithubInput,
} from "./github-skill-service.js";
import { GithubSkillReviewStore } from "./github-skill-review.js";
import { checkSkillUpdateEntry, updateSkillEntry } from "./skill-update-entry.js";
import { resolveModelMeta } from "./model-meta-service.js";
import { listRuns, getRun, deleteRunDir } from "./runs-service.js";
import {
  initUpdater,
  checkForUpdate,
  downloadUpdate,
  quitAndInstall,
  getLastStatus,
} from "./updater.js";
import { loadRecents, loadProjects } from "./recents-store.js";
import { getProjectStore } from "./project-store.js";
import { registerProjectAuthorityIpc } from "./project-authority-ipc.js";
import { reviewService } from "./review-service.js";
import { loadWindowState, saveWindowState } from "./window-state-store.js";
import {
  PET_WIDGET_WINDOW_SIZE,
  clampPetWidgetWindowPosition,
  defaultPetWidgetWindowPosition,
  loadPetWidgetWindowPosition,
  petWidgetAlwaysOnTopLevel,
  petWidgetSurface,
  sanitizePetWidgetWindowPosition,
  savePetWidgetWindowPosition,
  shouldSkipPetWidgetTaskbar,
  type PetWidgetSurfaceMode,
} from "./pet/pet-widget-window-state.js";
import {
  getTrust,
  getTrustCachedSync,
  setTrust,
  warmTrustCache,
  summarizeProjectTrustRisks,
  type TrustLevel,
} from "./trust-store.js";
import { installAppMenu } from "./menu.js";
import { seedDefaults } from "./seed-defaults.js";
import { bootstrapCorePlugins } from "./bootstrap-core-plugins.js";
import {
  probeMcpServers,
  invalidateMcpProbeCache,
  type McpServerConfig,
} from "./mcp-probe-service.js";
import { probeSearch, type SearchProbeInput } from "./search-probe-service.js";
import { probeImage, type ImageProbeInput } from "./image-probe-service.js";
import { parseDataUrl, suggestImageFilename } from "./image-save.js";
import { injectLoginShellPathAtStartup } from "./login-shell-path.js";
import {
  acquireDesktopInstanceLock,
  registerSecondInstanceFocus,
  runOwnedQuickChatStartupCleanup,
} from "./quick-chat-startup-cleanup.js";
import { getSessionCwdIndex } from "./session-cwd-index.js";
import {
  readSessionDirectoryForUi,
  readSessionFileForUi,
  sessionFileExistsForUi,
} from "./session-fs-service.js";
import {
  resolveRendererConfigurationTarget,
  type RendererConfigurationTarget,
} from "./renderer-configuration-authority.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
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
let petWidgetWindow: BrowserWindow | null = null;
let petWidgetWindowCreation: Promise<BrowserWindow> | null = null;
let petWidgetShouldBeVisible = false;
let petWidgetSurfaceMode: PetWidgetSurfaceMode = "collapsed";
let petWidgetPositionSaveTimer: ReturnType<typeof setTimeout> | null = null;
let markPetIpcReady: (() => void) | null = null;
const petIpcReady = new Promise<void>((resolveReady) => {
  markPetIpcReady = resolveReady;
});
const ownsDesktopInstance = chromeNativeMessagingOrigin ? false : acquireDesktopInstanceLock(app);
if (ownsDesktopInstance) {
  registerSecondInstanceFocus(
    (handler) => app.on("second-instance", handler),
    () => Array.from(mainWindows),
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
let chromeNativeRegistration: ChromeNativeRegistrationResult | undefined;
/**
 * Sessions backed by Codex / Claude Code instead of the native Engine.
 *
 * Created alongside the AgentBridge below (it needs the bridge for host-tool
 * seams) and torn down in `before-quit` — each session owns a child process and
 * a listening port, neither of which dies with the parent on Windows.
 */
let externalRuntimeService: ExternalRuntimeService | null = null;
/** Routes external-runtime tool approvals to the renderer's existing dialog. */
let externalRuntimeApprovals: ExternalRuntimeApprovals | null = null;
const panelAppBridge = new PanelAppBridge({
  isTrustedHost: (sender) =>
    [...mainWindows].some((window) => !window.isDestroyed() && window.webContents === sender),
  isWorkspaceTrusted: (cwd) => getTrustCachedSync(cwd) === "trusted",
  isPanelAppBound: isPanelAppBoundToProject,
  getAgentBridge: () => bridge,
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
            autoInjectByAI: credential.autoInjectByAI,
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
      store.save("user", {
        id: credentialId,
        type: "cookie",
        label: accountLabel,
        secret: JSON.stringify(capture.jar),
        meta: {
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
        const restored = await restoreCookiesToBrowser(
          capture.jar as ElectronCookieLike[],
          "merge",
          partition,
        );
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
      const credential = new CredentialStore(cwd).resolve(credentialId);
      if (!credential || credential.type !== "cookie") {
        throw new Error(`No saved Cookie login: ${credentialId}`);
      }
      let jar: ElectronCookieLike[];
      try {
        const parsed = JSON.parse(credential.secret ?? "[]");
        if (!Array.isArray(parsed)) throw new Error("not an array");
        jar = parsed as ElectronCookieLike[];
      } catch {
        return { invalid: true };
      }
      const mode = credential.meta?.switchMode === "clear" ? "clear" : "merge";
      const result = await restoreCookiesToBrowser(jar, mode, partition);
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
const imGatewayService = new ImGatewayService({
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
let petHostActionReceiptService: PetHostActionReceiptService | null = null;
let petAttentionPolicy: PetAttentionPolicy | null = null;
let petWorkInboxStore: PetWorkInboxStore | null = null;
let petLongTaskStore: PetLongTaskStore | null = null;
let petLongTaskCoordinator: PetLongTaskCoordinator | null = null;
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
// Trusted-device store + HTTP/WS host. The host is NOT started on launch — the
// user must explicitly Start it from Settings → Advanced. onClientEvent is a
// v1 echo placeholder; chat/approval routing is wired in a later task and must
// reuse the existing run/permission path rather than create a second runtime.
const mobileDevices = new TrustedDeviceStore(
  resolve(app.getPath("userData"), "mobile-remote", "devices.json"),
);
const mobileUploads = new MobileUploadService({
  rootDir: resolve(app.getPath("userData"), "mobile-remote", "uploads"),
});
const mobileRemote = new RemoteHostManager({
  devices: mobileDevices,
  uploads: mobileUploads,
  // The built mobile web app stays a desktop asset (out/mobile, sibling of the
  // bundled out/main) — pass it explicitly now that RemoteHostManager lives in
  // @cjhyy/code-shell-server and can no longer derive it from its own location.
  mobileRootDir: resolve(__dirname, "../mobile"),
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
let gatewayControlServer: GatewayControlServer | undefined;

/**
 * Publish once, then opportunistically hand the same event to the standalone
 * direct sender. When the live Gateway owns the stream the hand-off is a no-op;
 * when stopped, direct-capable adapters deliver it without task-layer coupling.
 */
async function publishGatewayControlEvent(event: GatewayControlEventInput): Promise<void> {
  const gateway = gatewayControlServer;
  if (!gateway) throw new Error("IM Gateway notification outbox is unavailable");
  const published = await gateway.publish(event);
  const context = gateway.eventContext();
  if (!context) return;
  void imGatewayService
    .deliverPublishedNotification(published, context)
    .then(async (delivered) => {
      if (delivered) await gateway.acknowledgeDirectDelivery(published.id);
    })
    .catch((error) =>
      dlog("main", "im_gateway.notification_direct.failed", {
        eventId: published.id,
        type: published.type,
        error: String(error),
      }),
    );
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
  resolveLinkedSession: resolveLinkedSessionFromDisk,
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
    mobileRemote.broadcast({ type: "room.message", roomId, msg });
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
const transcriptSubscriptions = new TranscriptSubscriptionManager({
  onStart: (roomId) => roomManager.beginTranscriptFollow(roomId),
  onStop: (roomId) => roomManager.endTranscriptFollow(roomId),
  roomCursor: (roomId) => roomManager.latestSeq(roomId),
  onMessages: (roomId, messages) => roomManager.ingestTranscriptMessages(roomId, messages),
});

// Routes authenticated mobile events into the same run/permission path the
// renderer uses (chat/approvals/sessions/rooms/cc-rooms). Extracted glue —
// see mobile-remote-orchestrator.ts.
const projectStore = getProjectStore();
const mobileOrchestrator = new MobileRemoteOrchestrator({
  remote: mobileRemote,
  uploads: mobileUploads,
  pendingApprovals: pendingMobileApprovals,
  roomManager,
  approvalBridge,
  transcriptSubscriptions,
  getBridge: () => bridge,
  broadcastToWindows: (channel, payload) => {
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send(channel, payload);
    }
  },
});

// An abruptly closed phone tab has no chance to send unsubscribe. Release the
// exact socket/viewer without disturbing another tab authenticated as the same
// device.
mobileRemote.on("viewer-offline", ({ viewerId }: MobileViewerIdentity) => {
  transcriptSubscriptions?.unsubscribeSubscriber(mobileTranscriptSubscriberId(viewerId));
});

// Idle-based room GC: rooms untouched for longer than this are reaped at
// startup (a running room is never reaped). Replaces the cleanup the removed
// one-shot /cc path never had.
const ROOM_MAX_IDLE_MS = 14 * 24 * 60 * 60 * 1000; // 14 days
try {
  const reaped = roomManager.pruneStaleRooms(ROOM_MAX_IDLE_MS);
  if (reaped.length) console.log(`[rooms] pruned ${reaped.length} stale room(s)`);
} catch {
  /* GC is best-effort; never block startup */
}

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
    // Partition = the guest's isolated storage/session. The renderer passes a
    // per-chat-session partition (`persist:browser:<bucket>`) so one session's
    // cookies/logged-in state/live page don't bleed into another's. Only honor a
    // `persist:browser`-prefixed value (defense-in-depth: never let a guest pick
    // an arbitrary partition, e.g. the app's own default session); anything else
    // → the shared browser partition.
    const wantPartition = typeof params.partition === "string" ? params.partition : "";
    params.partition =
      wantPartition === BROWSER_PARTITION || wantPartition.startsWith(`${BROWSER_PARTITION}:`)
        ? wantPartition
        : BROWSER_PARTITION;
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
    // Codex-style single-row header: hide the native macOS title bar
    // (keeps traffic-light), let renderer content flow under the
    // buttons. The .topbar element reserves a 70px gutter so its
    // contents don't sit underneath the traffic-light cluster.
    // Other platforms get the standard window frame (no-op there).
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    // Windows/Linux: hide the native menu bar (文件/编辑/视图) by default so it
    // doesn't clutter the window — it looked out of place jammed inside the
    // frame (macOS has a global menu bar; win/linux render it in-window). Still
    // reachable via Alt, and every item also has a shortcut / in-app affordance.
    // No-op on macOS (global menu bar, not in-window).
    autoHideMenuBar: process.platform !== "darwin",
    webPreferences: {
      preload: resolve(__dirname, "..", "preload", "index.cjs"),
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
            "img-src 'self' data: blob:; " +
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
            "img-src 'self' data:; " +
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

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e, url) => {
    const devUrl = process.env.VITE_DEV_URL ?? "";
    if (devUrl && url.startsWith(devUrl)) return;
    e.preventDefault();
    if (/^https?:/i.test(url)) void shell.openExternal(url);
  });

  const devUrl = process.env.VITE_DEV_URL;
  const noDevtools = process.env.CODE_SHELL_NO_DEVTOOLS === "1";
  if (devUrl) {
    win.loadURL(devUrl);
    if (!noDevtools) win.webContents.openDevTools({ mode: "right" });
  } else {
    win.loadFile(resolve(__dirname, "..", "renderer", "index.html"));
    if (!app.isPackaged && !noDevtools) win.webContents.openDevTools({ mode: "right" });
  }

  win.webContents.on("did-fail-load", (_e, code, desc, url) => {
    dlog("main", "renderer.did-fail-load", { code, desc, url });
  });
  win.webContents.on("render-process-gone", (_e, details) => {
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
  win.on("closed", () => {
    void externalRuntimeService?.stopOwnedBy(ownerWebContentsId);
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
      (req) => getMcpOAuthService().resolveAccessToken(req.id, { forceRefresh: req.forceRefresh }),
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
    );
    // External Agent Runtimes (Codex / Claude Code). Everything
    // security-relevant is resolved here, in the composition root: this is the
    // only layer that knows the owning window, whether the project is trusted,
    // and which feature flags are on. The layers below deliberately refuse to
    // default any of it.
    const externalBridge = bridge;
    // Approvals reach the SAME renderer dialog the native path uses — the
    // renderer cannot tell which transport a prompt arrived over, so there is
    // only one approval UI to keep correct.
    externalRuntimeApprovals = new ExternalRuntimeApprovals({
      windows: () => mainWindows,
      ownerWebContentsId: (sessionId) => externalBridge.panelOwnerWebContentsId(sessionId),
    });
    const approvals = externalRuntimeApprovals;
    externalRuntimeService = new ExternalRuntimeService({
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
      // Route events to the window that owns the session, not every window: a
      // second window showing a different session must not receive its stream.
      emit: (sessionId, event) => {
        const ownerId = externalBridge.panelOwnerWebContentsId(sessionId);
        const owner = [...mainWindows].find(
          (window) => !window.isDestroyed() && window.webContents.id === ownerId,
        );
        owner?.webContents.send("externalRuntime:event", { sessionId, event });
      },
      // The host seams the exposed tools need. `panels` points at the same
      // requestPanelHost the native protocol line reaches, so owner routing,
      // the timeout and invoke's fail-closed behaviour are shared rather than
      // reimplemented.
      toolContextOverrides: (sessionId) => ({
        panels: externalBridge.panelBridgeForSession(sessionId),
        browser: interactiveBrowserBridgeForSession(sessionId),
        injectCredentialToBrowser: (credentialId: string, scope?: "full" | "project") =>
          externalBridge.injectCredentialForSession(sessionId, credentialId, scope),
      }),
      requestApproval: (sessionId, request) => approvals.request(sessionId, request),
      cancelApprovals: (sessionId) => approvals.cancelSession(sessionId),
      backgroundWork: {
        subscribe: (listener) => agentNotificationBus.subscribe(listener),
        drainMessage: (sessionId) => {
          const pending = notificationQueue.drainAll(sessionId);
          return pending.length > 0 ? buildNotificationMessage(pending) : undefined;
        },
        hasPending: (sessionId) => notificationQueue.getSnapshot(sessionId).length > 0,
        dropSession: (sessionId) => {
          backgroundJobRegistry.dropForSession(sessionId);
          notificationQueue.reset(sessionId);
        },
      },
    });

    // Mirror every worker→renderer line onto any connected mobile clients, so
    // the phone sees the same stream (messages, tool summaries, approvals).
    bridge.subscribeOutbound((line, snapshotEntry) => {
      pendingMobileApprovals.observeOutboundLine(line);
      if (snapshotEntry) {
        mobileRemote.broadcast({
          type: "session.stream",
          sessionId: snapshotEntry.sessionId,
          seq: snapshotEntry.seq,
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
      onTaskClosed: async (task) => {
        if (!petSegmentController) throw new Error("Pet work-memory sink is not ready");
        await petSegmentController.onDelegationClosed({
          dedupeKey: `${task.id}:${task.attempt}:${task.status}`,
          objective: task.objective,
          outcome: task.status === "completed" ? "completed" : "failed",
          ...(task.workspacePath ? { workspace: task.workspacePath } : {}),
          sessionRef: task.sessionId,
        });

        let message = formatPetLongTaskClosureMessage(task);
        let continued = false;
        let closureHostActions: PetHostActionExecution[] | undefined;
        try {
          if (petDispatchService) {
            const report = await petDispatchService.reportLongTaskClosure(task);
            message = report.text;
            continued = report.continued;
            closureHostActions = report.hostActions;
          }
        } catch (error) {
          // The deterministic fallback below still reaches the originating IM
          // conversation and desktop notification when Mimi cannot compose a
          // richer receipt (for example while the worker is restarting).
          dlog("main", "pet.longTask.reply.failed", { error: String(error), taskId: task.id });
        }

        // A successful continuation is an internal manager hand-off. Mimi's
        // injected reply remains visible in her durable desktop conversation,
        // while the originating IM chat receives one push only when the chain
        // finishes, needs a user decision, or cannot continue.
        if (!continued) {
          const completed = task.status === "completed";
          const cancelled = task.status === "cancelled";
          const title = completed
            ? "Mimi 任务已完成"
            : cancelled
              ? "Mimi 任务已取消"
              : "Mimi 任务执行失败";
          const enriched = await enrichPetChatReplyWithHostActions(message, closureHostActions, {
            qrDir: resolve(app.getPath("userData"), "pet", "qr"),
            attachmentKinds: task.completionTarget?.replyAttachmentKinds,
          });
          message = enriched.text;
          const completionAttachments = enriched.attachments;
          await publishGatewayControlEvent({
            deliveryKey: createHash("sha256")
              .update("pet-task-closure\0")
              .update(task.id)
              .update("\0")
              .update(String(task.attempt))
              .update("\0")
              .update(task.status)
              .digest("hex"),
            type: completed
              ? "pet.task.completed"
              : cancelled
                ? "pet.task.cancelled"
                : "pet.task.failed",
            title,
            text: message,
            ...(enriched.button ? { button: enriched.button } : {}),
            ...(completionAttachments.length > 0 ? { attachments: completionAttachments } : {}),
            ...(task.completionTarget
              ? {
                  target: {
                    channel: task.completionTarget.channel,
                    target: task.completionTarget.target,
                  },
                }
              : {}),
          });

          // The closure manager's final assistant text is only an internal
          // acknowledgement after GatewayReply (for example, "微信消息已发送，待命").
          // Persist and publish the actual routed body as the visible reply,
          // with delivery state kept as separate UI metadata.
          const gatewayReplyAccepted = closureHostActions?.some(
            (execution) => execution.kind === "gatewayReply" && execution.ok,
          );
          if (
            gatewayReplyAccepted &&
            task.completionTarget &&
            petHostActionReceiptService &&
            petDispatchService
          ) {
            await completePetHostActionReceipt({
              recorder: petHostActionReceiptService,
              input: {
                petSessionId: await petDispatchService.getSessionId(),
                clientMessageId: task.originClientMessageId,
                executions: closureHostActions ?? [],
                authoritativeMessage: message,
                replaceAssistant: true,
                deliveryChannel: task.completionTarget.channel,
              },
              publish: (receiptEvent) => {
                for (const window of BrowserWindow.getAllWindows()) {
                  if (!window.isDestroyed()) {
                    window.webContents.send(PET_CHAT_EVENT_CHANNEL, receiptEvent);
                  }
                }
              },
            }).catch((error) =>
              dlog("main", "pet.longTask.gatewayReceipt.failed", {
                taskId: task.id,
                error: String(error),
              }),
            );
          }

          try {
            if (!BrowserWindow.getFocusedWindow() && Notification.isSupported()) {
              new Notification({
                title,
                body: message.replace(/\s+/gu, " ").trim().slice(0, 180),
              }).show();
            }
          } catch {
            // Desktop notifications are best-effort; the durable Mimi reply and
            // targeted IM receipt above remain the authoritative delivery paths.
          }
        }
      },
      onBackgroundError: (operation, error) => {
        dlog("main", `pet.longTask.${operation}.failed`, { error: String(error) });
      },
    });
    petLongTaskCoordinator = longTaskCoordinator;
    unsubscribePetLongTaskStream = bridge.subscribeOutbound((_line, snapshotEntry) => {
      if (!snapshotEntry) return;
      void longTaskCoordinator
        .observeSessionEvent(snapshotEntry.sessionId, snapshotEntry.event)
        .catch((error) => dlog("main", "pet.longTask.stream.failed", { error: String(error) }));
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
    const petFollowUps = createPetFollowUpService({
      listSessions: () => aggregator.getSnapshot().sessions,
      summaryStore: petSummaryStore,
      summaryService: petSummaryService,
      inbox: petWorkInbox,
    });
    petDispatchService = new PetDispatchService({
      metadata: petMetadata,
      aggregator,
      worker: bridge,
      hostCwd: resolveNoRepoCwd(),
      sessionsRootDir: petSessionsRootDir,
      managerModel: async () =>
        petChatModelKeyFromSettings(await readSettings("user").catch(() => null)),
      personalization: async () =>
        petPersonalizationFromSettings(await readSettings("user").catch(() => null)),
      segmentController: {
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
      hostActionReceipts: petHostActionReceipts,
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
        memory: async (payload) => {
          const action = payload.action;
          const text = typeof payload.text === "string" ? payload.text : "";
          const memoryId = typeof payload.memoryId === "string" ? payload.memoryId : "";
          if (action === "remember") {
            const before = new Map(
              petMemoryStoreInstance.list().map((entry) => [entry.id, entry] as const),
            );
            const entry = await petMemoryStoreInstance.remember(text, "mimi");
            const previous = before.get(entry.id);
            const unchanged =
              previous !== undefined &&
              previous.text === entry.text &&
              previous.source === entry.source &&
              previous.updatedAt === entry.updatedAt;
            return { action, id: entry.id, ...(unchanged ? { unchanged: true } : {}) };
          }
          if (action === "update") {
            const entry = await petMemoryStoreInstance.update(memoryId, text);
            return { action, id: entry.id };
          }
          if (action === "forget") {
            const entry = await petMemoryStoreInstance.forget(memoryId);
            return { action, id: entry.id };
          }
          throw new Error("invalid memory action");
        },
        followUpMutation: async (payload) => {
          const action = payload.action;
          const followUpId = typeof payload.followUpId === "string" ? payload.followUpId : "";
          if ((action !== "complete" && action !== "dismiss") || !followUpId) {
            throw new Error("invalid follow-up mutation request");
          }
          return petFollowUps.mutate({ action, followUpId });
        },
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
      worldContext: async () => {
        await petMemoryStoreInstance.load();
        const remote = getMobileRemoteGatewayStatus();
        const allMemories = petMemoryStoreInstance.list();
        const visibleMemories = allMemories.slice(0, 24);
        return {
          memories: visibleMemories.map(({ id, text, source, updatedAt }) => ({
            id,
            text,
            source,
            updatedAt,
          })),
          memoryWindow: {
            visibleCount: visibleMemories.length,
            totalCount: allMemories.length,
            truncated: visibleMemories.length < allMemories.length,
          },
          mobileRemote: {
            running: remote.running,
            tunnelConnected: remote.tunnelConnected,
            passcodeSet: remote.passcodeSet,
            ...(remote.url ? { url: remote.url } : {}),
          },
        };
      },
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
    const deliveredPetReports = new Set<string>();
    unsubscribePetReportStream = bridge.subscribePetReports(async (event) => {
      if (processingPetReports.has(event.reportId) || deliveredPetReports.has(event.reportId)) {
        return;
      }
      processingPetReports.add(event.reportId);
      try {
        const task = longTaskStore.latestForSession(event.sessionId);
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
        if (report.routedToOrigin) {
          const completionTarget = task?.completionTarget;
          const gateway = gatewayControlServer;
          if (!gateway || !completionTarget) {
            throw new Error("The originating IM Gateway route is unavailable");
          }
          const enriched = await enrichPetChatReplyWithHostActions(
            report.text,
            report.hostActions,
            {
              qrDir: resolve(app.getPath("userData"), "pet", "qr"),
              attachmentKinds: completionTarget.replyAttachmentKinds,
            },
          );
          await publishGatewayControlEvent({
            deliveryKey: createHash("sha256")
              .update("pet-task-report\0")
              .update(event.reportId)
              .digest("hex"),
            type: "pet.task.reported",
            title: "Mimi 工作更新",
            text: enriched.text,
            ...(enriched.button ? { button: enriched.button } : {}),
            ...(enriched.attachments.length > 0 ? { attachments: enriched.attachments } : {}),
            target: {
              channel: completionTarget.channel,
              target: completionTarget.target,
            },
          });
        } else if (
          event.deliveryRequest &&
          report.hostActions?.length &&
          petHostActionReceiptService
        ) {
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
        deliveredPetReports.add(event.reportId);
        if (deliveredPetReports.size > 1_000) {
          const oldest = deliveredPetReports.values().next().value;
          if (oldest) deliveredPetReports.delete(oldest);
        }
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
    const petReceipts = new PetReceiptStore(
      resolve(app.getPath("userData"), "pet", "attention-receipts.json"),
    );
    const attention = new PetAttentionPolicy({
      source: aggregator,
      receipts: petReceipts,
    });
    petAttentionPolicy = attention;
    const petInitialization = (async () => {
      await aggregator.start();
      await externalVisibility.reconcile();
      await Promise.all([
        petReceipts.load(),
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
        const response = await petBridge.requestWorker(
          "agent/query",
          {
            type: "archive_marker",
            sessionId: petSessionId,
            summary,
            toClientMessageId: activeSegment.boundaryBeforeMessageId,
            segmentId: "context-migration-v1",
          },
          { meta: { origin: "host", producer: "pet-context-migration" } },
        );
        if (!response.ok) throw new Error(response.message);
        const appended = (response.result as { data?: { appended?: boolean } })?.data?.appended;
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
      attention.start();
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
      attention,
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
    await petInitialization;
    markPetIpcReady?.();
    markPetIpcReady = null;
  } else {
    bridge.attachWindow(win);
  }

  await installAppMenu(win);
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
async function listAllDiskSessions(): Promise<
  Awaited<ReturnType<typeof listDiskSessions>>["sessions"]
> {
  const pageSize = 500;
  const maxPages = 200;
  const all: Awaited<ReturnType<typeof listDiskSessions>>["sessions"] = [];
  let cursor: string | undefined;
  for (let page = 0; page < maxPages; page += 1) {
    const result = await listDiskSessions({
      limit: pageSize,
      includeArchived: true,
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

function petWindowOriginForAnchor(
  anchor: { x: number; y: number },
  mode: PetWidgetSurfaceMode,
): { x: number; y: number } {
  const surface = petWidgetSurface(mode);
  return {
    x: anchor.x - (surface.width - PET_WIDGET_WINDOW_SIZE),
    y: anchor.y - (surface.height - PET_WIDGET_WINDOW_SIZE),
  };
}

function petAnchorForWindowOrigin(
  origin: { x: number; y: number },
  mode: PetWidgetSurfaceMode,
): { x: number; y: number } {
  const surface = petWidgetSurface(mode);
  return {
    x: origin.x + (surface.width - PET_WIDGET_WINDOW_SIZE),
    y: origin.y + (surface.height - PET_WIDGET_WINDOW_SIZE),
  };
}

function currentPetAnchor(win: BrowserWindow): { x: number; y: number } {
  const { x, y } = win.getBounds();
  return petAnchorForWindowOrigin({ x, y }, petWidgetSurfaceMode);
}

function clampPetPositionToDisplay(
  position: { x: number; y: number },
  mode = petWidgetSurfaceMode,
): { x: number; y: number } {
  const display = screen.getDisplayNearestPoint({
    x: position.x + Math.round(PET_WIDGET_WINDOW_SIZE / 2),
    y: position.y + Math.round(PET_WIDGET_WINDOW_SIZE / 2),
  });
  return clampPetWidgetWindowPosition(position, display.workArea, petWidgetSurface(mode));
}

function persistPetWidgetPosition(win: BrowserWindow): void {
  if (win.isDestroyed()) return;
  void savePetWidgetWindowPosition(currentPetAnchor(win));
}

function schedulePetWidgetPositionSave(win: BrowserWindow): void {
  if (petWidgetPositionSaveTimer) clearTimeout(petWidgetPositionSaveTimer);
  petWidgetPositionSaveTimer = setTimeout(() => {
    petWidgetPositionSaveTimer = null;
    persistPetWidgetPosition(win);
  }, 250);
}

function elevatePetWidgetWindow(win: BrowserWindow): void {
  if (win.isDestroyed()) return;
  win.setAlwaysOnTop(true, petWidgetAlwaysOnTopLevel(process.platform));
  try {
    // Refresh the z-order without stealing focus when the active application
    // or Space changes. Wayland may not implement this operation.
    win.moveTop();
  } catch {
    // The always-on-top level still applies when moveTop is unavailable.
  }
}

async function createPetWidgetWindowNow(): Promise<BrowserWindow> {
  if (petWidgetWindow && !petWidgetWindow.isDestroyed()) return petWidgetWindow;

  const savedPosition = await loadPetWidgetWindowPosition();
  const primaryWorkArea = screen.getPrimaryDisplay().workArea;
  const anchor = savedPosition
    ? clampPetPositionToDisplay(savedPosition, "collapsed")
    : defaultPetWidgetWindowPosition(primaryWorkArea);
  const position = petWindowOriginForAnchor(anchor, "collapsed");
  const win = new BrowserWindow({
    width: PET_WIDGET_WINDOW_SIZE,
    height: PET_WIDGET_WINDOW_SIZE,
    x: position.x,
    y: position.y,
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
  petWidgetSurfaceMode = "collapsed";
  petWidgetWindow = win;
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
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  } catch {
    // Some Linux window managers do not implement workspace pinning.
  }
  elevatePetWidgetWindow(win);

  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (event) => event.preventDefault());
  win.webContents.on("did-fail-load", (_event, code, desc, validatedUrl) => {
    dlog("main", "pet-widget.did-fail-load", { code, desc, validatedUrl });
  });
  win.webContents.on("console-message", (_event, level, message, line, sourceId) => {
    if (level >= 2) dlog("main", "pet-widget.console", { level, message, line, sourceId });
  });
  win.webContents.once("did-finish-load", () => {
    if (win.isDestroyed()) return;
    win.showInactive();
    elevatePetWidgetWindow(win);
  });
  // A crashed renderer leaves a blank, unresponsive widget that the visibility
  // checks still treat as "open" (window not destroyed), so toggling can't
  // recover it. Tear it down so the next open creates a fresh one.
  win.webContents.on("render-process-gone", (_event, details) => {
    dlog("main", "pet-widget.render-process-gone", { reason: details.reason });
    if (!win.isDestroyed()) win.destroy();
  });

  win.on("move", () => schedulePetWidgetPositionSave(win));
  win.on("show", () => elevatePetWidgetWindow(win));
  win.on("blur", () => elevatePetWidgetWindow(win));
  win.on("always-on-top-changed", (_event, isAlwaysOnTop) => {
    if (isAlwaysOnTop || !petWidgetShouldBeVisible) return;
    setImmediate(() => elevatePetWidgetWindow(win));
  });
  win.on("close", () => persistPetWidgetPosition(win));
  win.on("closed", () => {
    if (petWidgetPositionSaveTimer) {
      clearTimeout(petWidgetPositionSaveTimer);
      petWidgetPositionSaveTimer = null;
    }
    if (petWidgetWindow === win) petWidgetWindow = null;
    petWidgetSurfaceMode = "collapsed";
  });

  try {
    const devUrl = process.env.VITE_DEV_URL;
    if (devUrl) {
      const url = new URL(devUrl);
      url.searchParams.set("popout", "pet");
      await win.loadURL(url.toString());
    } else {
      await win.loadFile(resolve(__dirname, "..", "renderer", "index.html"), {
        query: { popout: "pet" },
      });
    }
  } catch (error) {
    // A failed load must not leave a blank window cached as petWidgetWindow —
    // every later create/visibility check would return this dead window. Tear
    // it down (the closed handler clears petWidgetWindow) and propagate so the
    // caller can retry with a fresh window.
    dlog("main", "pet-widget.load.failed", { error: String(error) });
    if (!win.isDestroyed()) win.destroy();
    throw error;
  }
  return win;
}

function createPetWidgetWindow(): Promise<BrowserWindow> {
  if (petWidgetWindow && !petWidgetWindow.isDestroyed()) return Promise.resolve(petWidgetWindow);
  if (petWidgetWindowCreation) return petWidgetWindowCreation;
  const creation = createPetWidgetWindowNow();
  petWidgetWindowCreation = creation;
  const clearCreation = (): void => {
    if (petWidgetWindowCreation === creation) petWidgetWindowCreation = null;
  };
  creation.then(clearCreation, clearCreation);
  return creation;
}

function setPetWidgetSurfaceMode(mode: PetWidgetSurfaceMode): void {
  const win = petWidgetWindow;
  if (!win || win.isDestroyed() || petWidgetSurfaceMode === mode) return;
  const anchor = currentPetAnchor(win);
  const nextAnchor = clampPetPositionToDisplay(anchor, mode);
  const origin = petWindowOriginForAnchor(nextAnchor, mode);
  const surface = petWidgetSurface(mode);
  petWidgetSurfaceMode = mode;
  win.setBounds({ ...origin, ...surface }, true);
  elevatePetWidgetWindow(win);
}

function destroyPetWidgetWindow(): void {
  const win = petWidgetWindow;
  if (!win || win.isDestroyed()) return;
  persistPetWidgetPosition(win);
  win.destroy();
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

async function dispatchGatewayPetChat(
  request: PetChatControlRequest,
): Promise<PetChatControlResult> {
  const dispatcher = petDispatchService;
  if (!dispatcher) throw new Error("Mimi Pet 尚未就绪，请稍后重试");
  const sessionId = await dispatcher.getSessionId();
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

  const result = await dispatcher.dispatch({
    type: "chat",
    message: request.message,
    ...(attachments.length > 0 ? { attachments } : {}),
    clientMessageId,
    source: {
      kind: "im-gateway",
      channel: sourceChannel,
      capabilities: request.origin?.capabilities ?? {
        inbound: { text: true, attachments: [] },
        outbound: { text: true, button: "link", attachments: [] },
      },
      ...(request.origin?.channels ? { channels: request.origin.channels } : {}),
      ...(request.origin ? { target: request.origin.target } : {}),
    },
  });
  if (!result.ok) throw new Error(result.message ?? result.code);
  if (result.type !== "chat") throw new Error("Mimi Pet 返回了非聊天结果");
  await markAttachmentsSent(cwd, sessionId, attachments).catch(() => undefined);
  const worker = result.result as { text?: unknown; reason?: unknown } | undefined;
  // Host-executed action outcomes (real tunnel address + pairing QR, task
  // state changes, memory confirmations) are appended here so the IM reply
  // carries what Mimi could only promise during her turn.
  const enriched = await enrichPetChatReplyWithHostActions(
    typeof worker?.text === "string" ? worker.text : "",
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
    Boolean(result.hostActions?.some((execution) => execution.kind === "gatewayReply"));
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
  await projectStore.warm();
  writeSettingsSchemaAtStartup();
  void cleanupKnownAttachments();
  // The main window and the pet popout both render on the default session, so
  // one handler there serves cstheme:// assets to every window.
  installThemeAssetProtocol();

  await chromeExtensionRuntimeService.start().catch((error) => {
    dlog("browser", "chrome_extension_bridge_start_failed", { error: String(error) });
  });
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
    open: () => startMobileRemote({ mode: "tunnel" }),
    close: () => stopMobileRemote(),
    status: () => getMobileRemoteGatewayStatus(),
    pairingUrl: () => createMobileRemotePairingUrl(),
    petChat: (request) => dispatchGatewayPetChat(request),
  });
  await gatewayControlServer.start().catch((error) => {
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

  // Main owns Electron safeStorage. Worker gets metadata snapshots and asks
  // main to resolve/materialize secrets on demand; if safeStorage is unavailable
  // SafeStorageCipher intentionally falls back to `plain:` owner-only storage.
  setDefaultCredentialCipher(new SafeStorageCipher());
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
  void warmTrustCache();
  void createWindow();
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
    // Feed in-main automation Engine events into the bridge's per-session
    // snapshot + renderer stream, so automation sessions reconnect identically
    // to interactive chat. `bridge?.` safely no-ops if a job somehow fires
    // before any window (and thus the bridge) exists.
    const emitAutomationEvent = (sessionId: string, event: unknown) =>
      bridge?.ingestExternalEvent(sessionId, event, { browserVisibility: "hidden" });
    const announceAutomationSession = (meta: {
      sessionId: string;
      cwd: string;
      title: string;
      prompt: string;
      cronJobId: string;
      clientMessageId?: string;
    }) => bridge?.broadcastAutomationSession(meta);
    // Each fired job runs as a one-shot read-only headless Engine, which
    // auto-writes a full transcript.jsonl (like interactive chat). The emit
    // callback streams events to a live snapshot for renderer reconnect; the
    // announce callback fires once with cwd+title so the renderer can place
    // the live run in the right project sidebar group immediately.
    const headlessAutomationRunner = buildDesktopAutomationRunner(
      emitAutomationEvent,
      announceAutomationSession,
    );
    // "Continue this conversation" jobs (job.resumeSessionId) don't run a
    // headless Engine — they feed their prompt into the LIVE session as a new
    // user turn, exactly like a human typing at a scheduled time. agent/run with
    // an existing sessionId makes the worker resume it from disk if it isn't
    // already live (engine.ts: exists()→resume). The run then inherits that
    // session's own cwd / permission mode / tools / background-completion wakeup.
    const injectResumeTurn = async (
      sessionId: string,
      prompt: string,
      _signal?: AbortSignal,
      job?: import("@cjhyy/code-shell-core/internal").CronJob,
    ): Promise<CronRunResult> => {
      if (!bridge) return { text: "", reason: "no-bridge" };
      // requireExisting: if the user deleted the target conversation, the worker
      // returns SessionNotFound instead of running the prompt against a blank
      // session. We turn that into a `stop` so the scheduler auto-disables this
      // recurring job (and the host notifies the user) rather than silently
      // re-firing into nothing every tick.
      const res = await injectAndAwaitResult(
        bridge,
        "agent/run",
        {
          task: prompt,
          sessionId,
          requireExisting: true,
          ...(job?.projectId ? { projectId: job.projectId } : {}),
          ...(job?.rootId ? { rootId: job.rootId } : {}),
        },
        { origin: "host", producer: "automation-resume" },
      );
      if (res.ok) {
        const r = res.result as { text?: string; reason?: string } | undefined;
        return { text: r?.text ?? "", reason: r?.reason ?? "done" };
      }
      if (res.code === ErrorCodes.SessionNotFound) {
        // Tell the user their scheduled "continue this conversation" job was
        // stopped because its target conversation is gone — best-effort, fires
        // even when focused since it's a rare, consequential state change.
        try {
          if (Notification.isSupported()) {
            new Notification({
              title: "定时任务已停止",
              body: "续接的对话已被删除,该定时任务已自动停用。可在自动化面板查看或删除。",
            }).show();
          }
        } catch {
          // Notifications are best-effort.
        }
        return {
          text: "",
          reason: "resume-target-missing",
          stop: { reason: "续接的对话已被删除,已停止该定时任务" },
        };
      }
      return { text: "", reason: res.message };
    };
    const automationRunner = makeCronRunnerWithResume(
      headlessAutomationRunner,
      injectResumeTurn,
      (job) => resolveDesktopAutomationJobWorkspace(job),
    );
    automationHandle = startAutomation({
      store: new CronStore(defaultCronStorePath()),
      runner: automationRunner,
      onJobEvent: (event) => {
        const notification = automationLifecycleNotification(event);
        if (!notification) return;
        publishGatewayControlEventBestEffort(notification);
        if (event.type !== "job_missed") return;
        try {
          if (Notification.isSupported()) {
            new Notification({
              title: notification.title ?? "定时任务已错过",
              body: notification.text,
            }).show();
          }
        } catch {
          // A missed-run notice is best-effort and must never affect re-arming.
        }
      },
    });
    // Expose the live scheduler to the automation IPC service (Phase 3 UI).
    setAutomationScheduler(automationHandle.scheduler);
    // startAutomation installed the default executor (bindCronToEngine):
    // every cron job runs one headless codeshell turn. Driving Claude Code is
    // just one such turn calling DriveClaudeCode — no CC-specific scheduling.

    // Surface background-agent completions (incl. automation runs) as desktop
    // notifications when the app isn't focused, so unattended jobs are visible.
    agentNotificationBus.subscribe((_sessionId, event) => {
      try {
        // The bus now also carries agent_heartbeat (liveness pings) — only a
        // background-agent COMPLETION should raise a desktop notification.
        if (event.type !== "background_agent_completed") return;
        if (BrowserWindow.getFocusedWindow()) return; // user is watching; skip
        const ok = event.status === "completed";
        const cancelled = event.status === "cancelled";
        new Notification({
          title: ok ? "自动化任务完成" : cancelled ? "自动化任务已取消" : "自动化任务失败",
          body: event.description?.slice(0, 120) ?? "",
        }).show();
      } catch {
        // Notifications are best-effort.
      }
    });
  } catch (err) {
    // Automation is non-critical to the GUI — never block startup on it.
    console.error("automation: failed to start", err);
  }

  // Defer initial sweep so the renderer has a chance to push current
  // git prefs via `git:setPrefs` first. Subsequent sweeps run hourly.
  setTimeout(() => void sweepStaleWorktrees("startup"), 5_000);
  setInterval(() => void sweepStaleWorktrees("interval"), 60 * 60_000);
});

async function rendererConfigurationCwd(target: RendererConfigurationTarget): Promise<string> {
  return (await resolveRendererConfigurationTarget(target)).cwd;
}

async function rendererOptionalConfigurationCwd(
  target: RendererConfigurationTarget | null,
  userCwd: string,
): Promise<string> {
  return target === null ? userCwd : rendererConfigurationCwd(target);
}

function rejectUnexpectedRendererKeys(
  input: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  const allowedSet = new Set(allowed);
  const unexpected = Object.keys(input).find((key) => !allowedSet.has(key));
  if (unexpected) throw new Error(`${label} does not accept ${unexpected}`);
}

async function requireRendererListedSkillPath(
  target: RendererConfigurationTarget | null,
  filePath: unknown,
): Promise<string> {
  if (typeof filePath !== "string" || !filePath) throw new Error("skill filePath is required");
  const cwd = await rendererOptionalConfigurationCwd(target, resolveNoRepoCwd());
  const listed = listSkills(cwd, { includeDisabled: true }).some(
    (skill) => resolve(skill.filePath) === resolve(filePath),
  );
  if (!listed) throw new Error("skill is not available for the configuration target");
  return filePath;
}

async function requireRendererListedAgentPath(
  target: RendererConfigurationTarget | null,
  filePath: unknown,
): Promise<string> {
  if (typeof filePath !== "string" || !filePath) throw new Error("agent filePath is required");
  const cwd = await rendererOptionalConfigurationCwd(target, "");
  const listed = listAgents(cwd).some((agent) => resolve(agent.filePath) === resolve(filePath));
  if (!listed) throw new Error("agent is not available for the configuration target");
  return filePath;
}

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
ipcMain.handle("profiles:list", async (_e, target: RendererConfigurationTarget | null) =>
  listProfiles(target === null ? undefined : await rendererConfigurationCwd(target)),
);
ipcMain.handle(
  "profiles:activate",
  async (_e, target: RendererConfigurationTarget, name: string) => {
    const cwd = await rendererConfigurationCwd(target);
    if (typeof name !== "string" || !name) throw new Error("profiles:activate requires name");
    activateProfile(cwd, name);
  },
);
ipcMain.handle("profiles:deactivate", async (_e, target: RendererConfigurationTarget) => {
  const cwd = await rendererConfigurationCwd(target);
  deactivateProfile(cwd);
});
ipcMain.handle("profiles:setSession", async (_e, sessionId: unknown, profileName: unknown) => {
  assertDesktopSessionId(sessionId);
  // "" is the unbind signal — a bare falsy check rejected it, so cancelling a
  // Session's digital human threw instead of clearing it.
  if (typeof profileName !== "string") {
    throw new Error("profiles:setSession requires profileName");
  }
  return setSessionWorkspaceProfile(sessionId, profileName);
});
ipcMain.handle("profiles:catalog", async () => listProfileCatalog());
ipcMain.handle("profiles:install", async (_e, name: string) => {
  if (typeof name !== "string" || !name) throw new Error("profiles:install requires name");
  installCatalogProfile(name);
});
ipcMain.handle("profiles:listRepos", async () => listProfileRepos());
ipcMain.handle("profiles:addRepo", async (_e, repo: string) => {
  if (typeof repo !== "string" || !repo) throw new Error("profiles:addRepo requires repo");
  return addProfileRepo(repo.trim());
});
ipcMain.handle("profiles:removeRepo", async (_e, repo: string) => {
  if (typeof repo !== "string" || !repo) throw new Error("profiles:removeRepo requires repo");
  removeProfileRepo(repo);
});
ipcMain.handle(
  "profiles:forceDelete",
  async (_e, name: string, target: RendererConfigurationTarget | null) => {
    if (typeof name !== "string" || !name) throw new Error("profiles:forceDelete requires name");
    const authorizedCwd = target === null ? undefined : await rendererConfigurationCwd(target);
    return forceDeleteProfile(name, authorizedCwd ? { cwd: authorizedCwd } : {});
  },
);
ipcMain.handle(
  "profiles:previewDeletion",
  async (_e, name: string, target: RendererConfigurationTarget | null) => {
    if (typeof name !== "string" || !name)
      throw new Error("profiles:previewDeletion requires name");
    return previewProfileDeletion(
      name,
      target === null ? undefined : await rendererConfigurationCwd(target),
    );
  },
);
ipcMain.handle(
  "profiles:previewRequirements",
  async (_e, name: string, target: RendererConfigurationTarget) => {
    if (typeof name !== "string" || !name) {
      throw new Error("profiles:previewRequirements requires name");
    }
    const cwd = await rendererConfigurationCwd(target);
    return previewProfileRequirements(name, cwd);
  },
);
ipcMain.handle(
  "profiles:installRequirements",
  async (_e, name: string, target: RendererConfigurationTarget) => {
    if (typeof name !== "string" || !name) {
      throw new Error("profiles:installRequirements requires name");
    }
    const cwd = await rendererConfigurationCwd(target);
    return installProfileRequirements(name, cwd);
  },
);
ipcMain.handle(
  "profiles:save",
  async (_e, profile: unknown, target: RendererConfigurationTarget | null) => {
    if (typeof profile !== "object" || profile === null || Array.isArray(profile)) {
      throw new Error("profiles:save requires profile");
    }
    const authorizedCwd = target === null ? undefined : await rendererConfigurationCwd(target);
    saveProfile(profile as Parameters<typeof saveProfile>[0], authorizedCwd);
  },
);
ipcMain.handle("profiles:pickDefinitionImport", async (event) => {
  const options: OpenDialogOptions = {
    title: "Import digital-human profile definition JSON",
    properties: ["openFile"],
    filters: [{ name: "JSON", extensions: ["json"] }],
  };
  const win = BrowserWindow.fromWebContents(event.sender);
  const result = win
    ? await dialog.showOpenDialog(win, options)
    : await dialog.showOpenDialog(options);
  const filePath = result.filePaths[0];
  if (result.canceled || !filePath) return { canceled: true };
  return { canceled: false, preview: previewProfileDefinitionImport(filePath) };
});
ipcMain.handle(
  "profiles:importReviewedDefinition",
  async (_e, input: unknown, target: RendererConfigurationTarget | null) => {
    if (typeof input !== "object" || input === null || Array.isArray(input)) {
      throw new Error("profiles:importReviewedDefinition requires input");
    }
    const candidate = input as { reviewToken?: unknown; overwrite?: unknown };
    if (typeof candidate.reviewToken !== "string" || !candidate.reviewToken) {
      throw new Error("profiles:importReviewedDefinition requires reviewToken");
    }
    if (candidate.overwrite !== undefined && typeof candidate.overwrite !== "boolean") {
      throw new Error("profiles:importReviewedDefinition overwrite must be a boolean");
    }
    const authorizedCwd = target === null ? undefined : await rendererConfigurationCwd(target);
    return importReviewedProfileDefinition(
      {
        reviewToken: candidate.reviewToken,
        ...(candidate.overwrite === undefined ? {} : { overwrite: candidate.overwrite }),
      },
      authorizedCwd,
    );
  },
);
ipcMain.handle("profiles:exportDefinition", async (event, name: string) => {
  if (typeof name !== "string" || !WORKSPACE_PROFILE_NAME_RE.test(name)) {
    throw new Error("profiles:exportDefinition requires a valid profile name");
  }
  const options: SaveDialogOptions = {
    title: "Export digital-human profile definition JSON",
    defaultPath: `${name}.codeshell-profile.json`,
    filters: [{ name: "JSON", extensions: ["json"] }],
  };
  const win = BrowserWindow.fromWebContents(event.sender);
  const result = win
    ? await dialog.showSaveDialog(win, options)
    : await dialog.showSaveDialog(options);
  if (result.canceled || !result.filePath) return { canceled: true };
  return exportProfileDefinition(name, result.filePath);
});
ipcMain.handle("profiles:exportRepo", async (event, names: string[]) => {
  if (!Array.isArray(names) || names.length === 0 || names.some((n) => typeof n !== "string")) {
    throw new Error("profiles:exportRepo requires profile names");
  }
  const win = BrowserWindow.fromWebContents(event.sender);
  const options = {
    title: "Export digital humans as a publishable repo",
    properties: ["openDirectory", "createDirectory"] as const,
  };
  const picked = win
    ? await dialog.showOpenDialog(win, { ...options, properties: [...options.properties] })
    : await dialog.showOpenDialog({ ...options, properties: [...options.properties] });
  if (picked.canceled || picked.filePaths.length === 0) return { canceled: true };
  return exportProfileRepo(names, picked.filePaths[0]);
});
ipcMain.handle(
  "profiles:delete",
  async (
    _e,
    name: string,
    options?: {
      target?: RendererConfigurationTarget | null;
      clearActiveProject?: boolean;
    },
  ) => {
    if (typeof name !== "string" || !name) throw new Error("profiles:delete requires name");
    if (options !== undefined && (typeof options !== "object" || options === null)) {
      throw new Error("profiles:delete options must be an object");
    }
    if (options) {
      rejectUnexpectedRendererKeys(
        options as Record<string, unknown>,
        ["target", "clearActiveProject"],
        "profiles:delete",
      );
    }
    if (
      options?.clearActiveProject !== undefined &&
      typeof options.clearActiveProject !== "boolean"
    ) {
      throw new Error("profiles:delete clearActiveProject must be a boolean");
    }
    const cwd =
      options?.target == null ? undefined : await rendererConfigurationCwd(options.target);
    deleteProfile(name, {
      ...(cwd ? { cwd } : {}),
      ...(options?.clearActiveProject === undefined
        ? {}
        : { clearActiveProject: options.clearActiveProject }),
    });
  },
);
ipcMain.handle("digital-human-teams:list", async () =>
  listDigitalHumanTeams({
    onInvalidTeam: (issue) => dlog("main", "digital_human_team.invalid", { ...issue }),
  }),
);
ipcMain.handle("digital-human-teams:save", async (_e, team: unknown) =>
  saveDigitalHumanTeam(team as Parameters<typeof saveDigitalHumanTeam>[0]),
);
ipcMain.handle("digital-human-teams:delete", async (_e, id: string) => {
  if (typeof id !== "string" || !id) throw new Error("digital-human-teams:delete requires id");
  deleteDigitalHumanTeam(id);
});
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
ipcMain.handle("panel-apps:list", async (_e, cwd: string, locale: string) => {
  cwd = await requireRendererProjectPath(cwd);
  if (typeof locale !== "string" || locale.length > 64) {
    throw new Error("panel-apps:list requires locale");
  }
  return listPanelApps(cwd, locale);
});
ipcMain.handle("panel-apps:listExtensions", async (_e, cwd: string, locale: string) => {
  cwd = await requireRendererProjectPath(cwd);
  if (typeof locale !== "string" || locale.length > 64) {
    throw new Error("panel-apps:listExtensions requires locale");
  }
  return listPanelAppExtensions(cwd, locale);
});
ipcMain.handle("panel-apps:listForProjects", async (_e, projectPaths: string[], locale: string) => {
  if (!Array.isArray(projectPaths) || projectPaths.length > 64) {
    throw new Error("panel-apps:listForProjects requires projectPaths");
  }
  if (typeof locale !== "string" || locale.length > 64) {
    throw new Error("panel-apps:listForProjects requires locale");
  }
  const authorizedPaths = await Promise.all(
    projectPaths.map((path) => requireRendererProjectPath(path)),
  );
  return listPanelAppsForProjects(authorizedPaths, locale);
});

// ── Credentials (token/link store + cookie capture) ──────────────────
// cwd may be "" for no-repo contexts; project scope no-ops without a cwd.
ipcMain.handle("credentials:list", async (_e, cwd: string) => {
  const authorizedCwd = cwd ? await requireRendererProjectPath(cwd) : "";
  await migrateCredentialStore(authorizedCwd || undefined);
  return new CredentialStore(authorizedCwd || undefined).listMasked();
});
ipcMain.handle(
  "credentials:save",
  async (_e, cwd: string, scope: CredentialScope, cred: Credential) => {
    const authorizedCwd = cwd ? await requireRendererProjectPath(cwd) : "";
    new CredentialStore(authorizedCwd || undefined).save(scope, cred);
    bridge?.pushCredentialSnapshot(authorizedCwd || undefined);
  },
);
ipcMain.handle(
  "credentials:remove",
  async (_e, cwd: string, scope: CredentialScope, id: string) => {
    const authorizedCwd = cwd ? await requireRendererProjectPath(cwd) : "";
    new CredentialStore(authorizedCwd || undefined).remove(scope, id);
    bridge?.pushCredentialSnapshot(authorizedCwd || undefined);
  },
);
ipcMain.handle("links:listLocalProviders", () => listDesktopLinkProviders());

async function persistLocalLinkCredential(input: {
  cwd: string;
  providerId: string;
  methodId: string;
  label: string;
  token: string;
  browserOAuthToken?: LocalBrowserAuthToken;
  existingId: string;
  authSource: "manual-token" | "browser-oauth";
}) {
  const { cwd, providerId, methodId, label, token, browserOAuthToken, existingId, authSource } =
    input;
  const credentialId = existingId || `link-${providerId}-${methodId}`;
  const store = new CredentialStore(cwd || undefined);
  if (existingId) {
    const current = store.resolve(existingId, "full");
    if (
      !current ||
      current.type !== "link" ||
      current.meta?.linkProvider !== providerId ||
      current.meta.linkConnectionMethod !== methodId ||
      current.meta.linkExecutionRuntime !== "local"
    ) {
      throw new Error("The existing credential does not belong to this local Link provider");
    }
  }

  // Validation and save are one main-process operation: the renderer never
  // receives the token back and an invalid replacement never overwrites the
  // last working credential.
  const validation = await validateLocalLinkToken(providerId, token);
  store.save("user", {
    id: credentialId,
    type: "link",
    label: label || `${providerId} · ${methodId}`,
    secret: browserOAuthToken
      ? JSON.stringify({
          version: 1,
          accessToken: browserOAuthToken.accessToken,
          refreshToken: browserOAuthToken.refreshToken,
          expiresAt:
            browserOAuthToken.expiresIn === undefined
              ? undefined
              : new Date(Date.now() + browserOAuthToken.expiresIn * 1_000).toISOString(),
          refreshTokenExpiresAt:
            browserOAuthToken.refreshTokenExpiresIn === undefined
              ? undefined
              : new Date(
                  Date.now() + browserOAuthToken.refreshTokenExpiresIn * 1_000,
                ).toISOString(),
          tokenType: browserOAuthToken.tokenType,
          scope: browserOAuthToken.scope,
          tokenEndpoint: browserOAuthToken.tokenEndpoint,
          clientId: browserOAuthToken.clientId,
        })
      : token,
    autoUseByAI: false,
    meta: {
      linkProvider: providerId,
      linkConnectionMethod: methodId,
      linkExecutionRuntime: "local",
      linkAuthSource: authSource,
      linkExecutionBackend: "http-token",
      agentExposable: false,
      linkAccountId: validation.identity.externalAccountId,
      linkAccountLabel: validation.identity.label,
      linkResourceLabels: validation.identity.resourceLabels,
      linkCapabilityIds: validation.capabilityIds,
      linkLastVerifiedAt: validation.verifiedAt,
    },
  });
  bridge?.pushCredentialSnapshot(cwd || undefined);
  return validation;
}

async function persistCliLinkCredential(input: {
  cwd: string;
  providerId: CliLinkProviderId;
  methodId: string;
  label: string;
  existingId: string;
  loginIfNeeded: boolean;
}) {
  const { cwd, providerId, methodId, label, existingId, loginIfNeeded } = input;
  const provider = listDesktopLinkProviders().find((candidate) => candidate.id === providerId);
  const method = provider?.connectionMethods.find((candidate) => candidate.id === methodId);
  if (!provider || !method?.quickAuth || method.quickAuth.kind !== "cli-session") {
    throw new Error("This Link connection method does not support a CLI session");
  }
  const store = new CredentialStore(cwd || undefined);
  const credentialId = existingId || `link-${providerId}-${methodId}`;
  if (existingId) {
    const current = store.resolve(existingId, "full");
    if (
      !current ||
      current.type !== "link" ||
      current.meta?.linkProvider !== providerId ||
      current.meta.linkConnectionMethod !== methodId ||
      current.meta.linkExecutionRuntime !== "local"
    ) {
      throw new Error("The existing credential does not belong to this local Link provider");
    }
  }

  const validation = await connectCliLink(providerId, { cwd: cwd || undefined, loginIfNeeded });
  store.save("user", {
    id: credentialId,
    type: "link",
    label: label || `${provider.displayName} · ${validation.identity.label}`,
    // This random value is only an encrypted binding marker. It is never sent
    // to the provider and never used to authenticate a Link Action.
    secret: `cli-binding:${randomBytes(24).toString("base64url")}`,
    autoUseByAI: false,
    meta: {
      linkProvider: providerId,
      linkConnectionMethod: methodId,
      linkExecutionRuntime: "local",
      linkAuthSource: "cli-session",
      linkExecutionBackend: "cli",
      agentExposable: false,
      linkAccountId: validation.identity.externalAccountId,
      linkAccountLabel: validation.identity.label,
      linkResourceLabels: validation.identity.resourceLabels,
      linkCapabilityIds: validation.capabilityIds,
      linkLastVerifiedAt: validation.verifiedAt,
    },
  });
  bridge?.pushCredentialSnapshot(cwd || undefined);
  return validation;
}

ipcMain.handle("links:cliStatus", async (_e, rawProviderId: unknown, rawCwd: unknown) => {
  const providerId = typeof rawProviderId === "string" ? rawProviderId.trim() : "";
  const cwd =
    typeof rawCwd === "string" && rawCwd ? await requireRendererProjectPath(rawCwd) : undefined;
  if (!isCliLinkProvider(providerId)) throw new Error("Unsupported CLI Link provider");
  return getCliLinkStatus(providerId, { cwd });
});

ipcMain.handle("links:cliInstallStatus", (_e, rawProviderId: unknown) => {
  const providerId = typeof rawProviderId === "string" ? rawProviderId.trim() : "";
  return managedCliInstallStatus(providerId);
});

ipcMain.handle("links:installCli", async (_e, rawProviderId: unknown) => {
  const providerId = typeof rawProviderId === "string" ? rawProviderId.trim() : "";
  if (!isCliLinkProvider(providerId)) throw new Error("Unsupported CLI Link provider");
  const current = managedCliInstallJobs.get(providerId);
  if (current) return current;
  const job = installManagedLinkCli(providerId).finally(() => {
    managedCliInstallJobs.delete(providerId);
  });
  managedCliInstallJobs.set(providerId, job);
  return job;
});

ipcMain.handle("links:browserAuthStatus", (_e, rawProviderId: unknown) => {
  const providerId = typeof rawProviderId === "string" ? rawProviderId.trim() : "";
  if (!isLocalBrowserLinkProvider(providerId)) {
    throw new Error("Unsupported browser-login Link provider");
  }
  return linkDeviceOAuthBroker.status(providerId);
});

ipcMain.handle("links:startBrowserAuth", async (_e, rawProviderId: unknown) => {
  const providerId = typeof rawProviderId === "string" ? rawProviderId.trim() : "";
  if (!isLocalBrowserLinkProvider(providerId)) {
    throw new Error("Unsupported browser-login Link provider");
  }
  const prompt = await linkDeviceOAuthBroker.start(providerId);
  clipboard.writeText(prompt.userCode);
  try {
    await shell.openExternal(prompt.verificationUriComplete ?? prompt.verificationUri);
  } catch (error) {
    linkDeviceOAuthBroker.cancel(prompt.attemptId);
    throw new Error("Could not open the provider authorization page", { cause: error });
  }
  return { ...prompt, codeCopied: true };
});

ipcMain.handle("links:completeBrowserAuth", async (_e, raw: unknown) => {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("links:completeBrowserAuth requires a connection request");
  }
  const input = raw as Record<string, unknown>;
  const attemptId = typeof input.attemptId === "string" ? input.attemptId.trim() : "";
  const rawCwd = typeof input.cwd === "string" ? input.cwd : "";
  const cwd = rawCwd ? await requireRendererProjectPath(rawCwd) : "";
  const providerId = typeof input.providerId === "string" ? input.providerId.trim() : "";
  const methodId = typeof input.methodId === "string" ? input.methodId.trim() : "";
  const label = typeof input.label === "string" ? input.label.trim() : "";
  const existingId = typeof input.existingId === "string" ? input.existingId.trim() : "";
  if (!attemptId || !isLocalBrowserLinkProvider(providerId)) {
    throw new Error("Invalid browser-login Link attempt");
  }
  if (!/^[a-z0-9][a-z0-9-]{0,80}$/.test(methodId)) {
    throw new Error("Invalid local Link connection method");
  }
  if (label.length > 200) throw new Error("Connection label is too long");
  const token = await linkDeviceOAuthBroker.complete(attemptId);
  if (token.providerId !== providerId) {
    throw new Error("Browser-login provider does not match the connection request");
  }
  return persistLocalLinkCredential({
    cwd,
    providerId,
    methodId,
    label,
    token: token.accessToken,
    browserOAuthToken: token,
    existingId,
    authSource: "browser-oauth",
  });
});

ipcMain.handle("links:cancelBrowserAuth", (_e, rawAttemptId: unknown) => {
  const attemptId = typeof rawAttemptId === "string" ? rawAttemptId.trim() : "";
  return attemptId ? linkDeviceOAuthBroker.cancel(attemptId) : false;
});

ipcMain.handle("links:connectCli", async (_e, raw: unknown) => {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("links:connectCli requires a connection request");
  }
  const input = raw as Record<string, unknown>;
  const rawCwd = typeof input.cwd === "string" ? input.cwd : "";
  const cwd = rawCwd ? await requireRendererProjectPath(rawCwd) : "";
  const rawProviderId = typeof input.providerId === "string" ? input.providerId.trim() : "";
  const methodId = typeof input.methodId === "string" ? input.methodId.trim() : "";
  const label = typeof input.label === "string" ? input.label.trim() : "";
  const existingId = typeof input.existingId === "string" ? input.existingId.trim() : "";
  const loginIfNeeded = input.loginIfNeeded === true;
  if (!isCliLinkProvider(rawProviderId)) throw new Error("Unsupported CLI Link provider");
  if (!/^[a-z0-9][a-z0-9-]{0,80}$/.test(methodId)) throw new Error("Invalid Link method");
  if (label.length > 200) throw new Error("Connection label is too long");

  return persistCliLinkCredential({
    cwd,
    providerId: rawProviderId,
    methodId,
    label,
    existingId,
    loginIfNeeded,
  });
});

ipcMain.handle("links:connectLocal", async (_e, raw: unknown) => {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("links:connectLocal requires a connection request");
  }
  const input = raw as Record<string, unknown>;
  const rawCwd = typeof input.cwd === "string" ? input.cwd : "";
  const cwd = rawCwd ? await requireRendererProjectPath(rawCwd) : "";
  const providerId = typeof input.providerId === "string" ? input.providerId.trim() : "";
  const methodId = typeof input.methodId === "string" ? input.methodId.trim() : "";
  const label = typeof input.label === "string" ? input.label.trim() : "";
  const token = typeof input.token === "string" ? input.token.trim() : "";
  const existingId = typeof input.existingId === "string" ? input.existingId.trim() : "";
  if (!providerId || !methodId || !token) {
    throw new Error("Provider, connection method, and token are required");
  }
  if (!/^[a-z0-9][a-z0-9-]{0,80}$/.test(methodId)) {
    throw new Error("Invalid local Link connection method");
  }
  if (label.length > 200) throw new Error("Connection label is too long");
  if (token.length > 16_384) throw new Error("Token is too long");

  return persistLocalLinkCredential({
    cwd,
    providerId,
    methodId,
    label,
    token,
    existingId,
    authSource: "manual-token",
  });
});
// 只改元数据(label/autoUseByAI/meta),保留 secret —— UI 的编辑/AI 开关用,避免清空 jar。
ipcMain.handle(
  "credentials:patchMeta",
  async (
    _e,
    cwd: string,
    scope: CredentialScope,
    id: string,
    fields: {
      label?: string;
      exposeAsEnv?: string;
      autoUseByAI?: boolean;
      autoInjectByAI?: boolean;
      meta?: unknown;
    },
  ) => {
    const authorizedCwd = cwd ? await requireRendererProjectPath(cwd) : "";
    if (typeof id !== "string" || !id || id.length > 512 || id.includes("\0")) {
      throw new Error("credentials:patchMeta requires id");
    }
    if (!fields || typeof fields !== "object" || Array.isArray(fields)) {
      throw new Error("credentials:patchMeta requires fields");
    }
    new CredentialStore(authorizedCwd || undefined).patch(scope, id, fields as never);
    bridge?.pushCredentialSnapshot(authorizedCwd || undefined);
  },
);
ipcMain.handle("mcpOAuth:login", (_e, raw: unknown) =>
  getMcpOAuthService().login(normalizeMcpOAuthLoginInput(raw)),
);
ipcMain.handle("mcpOAuth:refresh", (_e, credentialId: unknown) => {
  if (typeof credentialId !== "string" || !credentialId) {
    throw new Error("mcpOAuth:refresh requires credentialId");
  }
  return getMcpOAuthService().refresh(credentialId);
});
ipcMain.handle("mcpOAuth:logout", (_e, credentialId: unknown) => {
  if (typeof credentialId !== "string" || !credentialId) {
    throw new Error("mcpOAuth:logout requires credentialId");
  }
  return getMcpOAuthService().logout(credentialId);
});
function browserPartitionForBucket(bucket: unknown): string | undefined {
  if (typeof bucket !== "string" || !bucket || bucket.length > 512 || bucket.includes("\0")) {
    return undefined;
  }
  // MUST match PanelArea/WebviewHost's partition exactly (no trim), or
  // capture/restore would target a different partition than the panel writes.
  return registryPartitionForBucket(bucket);
}

function assertRendererSessionAccess(sessionId: unknown, senderWebContentsId: number): string {
  assertDesktopSessionId(sessionId);
  if (!bridge?.hasKnownSession(sessionId)) {
    throw new Error("browser operation requires a live CodeShell task");
  }
  const ownerId = bridge.panelOwnerWebContentsId(sessionId);
  // Headless/mobile sessions intentionally have no panel owner and may be
  // presented by a desktop window. Once a session has an owner, however, a
  // second window must never rebind or control its browser capability.
  if (ownerId !== undefined && ownerId !== senderWebContentsId) {
    throw new Error("browser operation belongs to another window");
  }
  return sessionId;
}

function requireRendererBrowserPartition(bucket: unknown, senderWebContentsId: number): string {
  const partition = browserPartitionForBucket(bucket);
  if (!partition || typeof bucket !== "string") {
    throw new Error("a bounded browser bucket is required");
  }
  const sessionIds = sessionIdsForBucket(bucket);
  const authorized = sessionIds.some((sessionId) => {
    if (!bridge?.hasKnownSession(sessionId)) return false;
    const ownerId = bridge.panelOwnerWebContentsId(sessionId);
    return ownerId === undefined || ownerId === senderWebContentsId;
  });
  if (!authorized) throw new Error("browser bucket belongs to another window");
  return partition;
}

ipcMain.on(
  "browser:register-session-bucket",
  (event, payload: { sessionId?: unknown; bucket?: unknown; partition?: unknown }) => {
    try {
      const sessionId = typeof payload?.sessionId === "string" ? payload.sessionId : "";
      const bucket = typeof payload?.bucket === "string" ? payload.bucket : "";
      const partition = typeof payload?.partition === "string" ? payload.partition : undefined;
      if (!sessionId || !bucket || bucket.length > 512 || bucket.includes("\0")) return;
      if (partition !== undefined && (partition.length > 1_024 || partition.includes("\0"))) return;
      const existingBucket = bucketForSession(sessionId);
      if (!existingBucket) {
        if (!bridge?.hasKnownSession(sessionId)) {
          dlog("browser", "register_session_bucket_rejected", {
            sessionId,
            reason: "no main-owned session",
          });
          return;
        }
        assertRendererSessionAccess(sessionId, event.sender.id);
        registerSessionBucket(sessionId, bucket, partition);
        return;
      }
      assertRendererSessionAccess(sessionId, event.sender.id);
      if (existingBucket !== bucket) {
        // External runtimes intentionally own an isolated browser partition.
        // A late renderer effect must never rebind it to the visible session
        // bucket; ignore that stale registration instead of emitting a noisy
        // error after the external runtime has already started successfully.
        if (existingBucket === externalRuntimeBrowserBucket(sessionId)) return;
        throw new Error(
          `renderer attempted to rebind session ${sessionId} from ${existingBucket} to ${bucket}`,
        );
      }
      registerSessionBucket(sessionId, bucket, partition);
    } catch (err) {
      dlog("browser", "register_session_bucket_failed", { error: String(err) });
    }
  },
);

ipcMain.on(
  "browser:guest-attached",
  (
    e,
    payload: {
      guestId?: unknown;
      bucket?: unknown;
      partition?: unknown;
      engineSessionId?: unknown;
    },
  ) => {
    try {
      const guestId =
        typeof payload?.guestId === "number" ? payload.guestId : Number(payload?.guestId);
      const bucket = typeof payload?.bucket === "string" ? payload.bucket : "";
      const partition = typeof payload?.partition === "string" ? payload.partition : "";
      if (
        !Number.isSafeInteger(guestId) ||
        guestId <= 0 ||
        !bucket ||
        bucket.length > 512 ||
        bucket.includes("\0") ||
        !partition ||
        partition.length > 1_024 ||
        partition.includes("\0")
      ) {
        return;
      }
      const ownerWindow = BrowserWindow.fromWebContents(e.sender);
      if (!ownerWindow) return;
      if (payload?.engineSessionId !== undefined) {
        assertRendererSessionAccess(payload.engineSessionId, e.sender.id);
      }
      registerAttachedGuestMetadata({
        guestId,
        bucket,
        partition,
        engineSessionId:
          typeof payload?.engineSessionId === "string" ? payload.engineSessionId : undefined,
        windowId: ownerWindow.id,
        source: "panel",
      });
    } catch (err) {
      dlog("browser", "guest_attached_failed", { error: String(err) });
    }
  },
);

ipcMain.handle(
  "browser-runtime:grant-built-in",
  (e, payload: { sessionId?: unknown; guestId?: unknown; ttlMs?: unknown }) => {
    const sessionId = assertRendererSessionAccess(payload?.sessionId, e.sender.id);
    const guestId =
      typeof payload?.guestId === "number" ? payload.guestId : Number(payload?.guestId);
    if (!Number.isSafeInteger(guestId) || guestId <= 0) {
      throw new Error("browser handoff requires a live task and browser tab");
    }
    const ownerWindow = BrowserWindow.fromWebContents(e.sender);
    if (!ownerWindow) throw new Error("browser handoff requires an owning window");
    const status = builtInBrowserHandoffGrants.grant({
      sessionId,
      guestId,
      sourceWindowId: ownerWindow.id,
      ttlMs:
        typeof payload.ttlMs === "number" &&
        Number.isSafeInteger(payload.ttlMs) &&
        payload.ttlMs > 0
          ? payload.ttlMs
          : undefined,
    });
    // Switching targets is explicit. Dispose the independent runtime target so
    // there is never a second browser silently continuing in the background.
    chromeExtensionRuntimeService.revoke(sessionId);
    browserRuntime.close(interactiveBrowserRuntimeOwner(sessionId));
    return status;
  },
);

ipcMain.handle("browser-runtime:revoke-built-in", (event, rawSessionId: unknown) => {
  const sessionId = assertRendererSessionAccess(rawSessionId, event.sender.id);
  builtInBrowserHandoffGrants.revoke(sessionId);
  return builtInBrowserHandoffGrants.status(sessionId);
});

ipcMain.handle("browser-runtime:handoff-status", (event, rawSessionId: unknown) => {
  const sessionId = assertRendererSessionAccess(rawSessionId, event.sender.id);
  return builtInBrowserHandoffGrants.status(sessionId);
});

ipcMain.handle(
  "browser-runtime:chrome-begin-pairing",
  (event, payload: { sessionId?: unknown; label?: unknown }) => {
    const sessionId = assertRendererSessionAccess(payload?.sessionId, event.sender.id);
    if (
      payload?.label !== undefined &&
      (typeof payload.label !== "string" ||
        payload.label.length > 200 ||
        payload.label.includes("\0"))
    ) {
      throw new Error("Chrome pairing label is invalid");
    }
    return chromeExtensionRuntimeService.beginPairing(
      sessionId,
      typeof payload.label === "string" ? payload.label : undefined,
    );
  },
);

ipcMain.handle("browser-runtime:chrome-status", (event, rawSessionId: unknown) => {
  const sessionId = assertRendererSessionAccess(rawSessionId, event.sender.id);
  return chromeExtensionRuntimeService.status(sessionId);
});

ipcMain.handle("browser-runtime:chrome-revoke", (event, rawSessionId: unknown) => {
  const sessionId = assertRendererSessionAccess(rawSessionId, event.sender.id);
  return chromeExtensionRuntimeService.revoke(sessionId);
});

ipcMain.handle("browser-runtime:chrome-installation", () => ({
  ...(chromeNativeRegistration ?? {
    installed: false,
    manifestPaths: [],
    extensionPath: app.isPackaged
      ? join(process.resourcesPath, "packages", "desktop", "resources", "chrome-extension")
      : join(app.getAppPath(), "resources", "chrome-extension"),
    detail: "Chrome bridge is still starting",
  }),
}));

ipcMain.handle("credentials:cookieDomains", async (event, bucket?: string) =>
  listCookieDomains(requireRendererBrowserPartition(bucket, event.sender.id)),
);
ipcMain.handle("credentials:cookiePreview", async (event, domain: string, bucket?: string) => {
  if (
    typeof domain !== "string" ||
    !domain.trim() ||
    domain.length > 253 ||
    domain.includes("\0")
  ) {
    throw new Error("credentials:cookiePreview requires a bounded domain");
  }
  // Preview only: just count the cookies in the partition. No lease file is
  // materialized here — the actual cookies.txt is created on demand by the
  // (deferred) UseGate when a tool call is approved.
  const cookies = await getCookiesForDomain(
    domain.trim(),
    requireRendererBrowserPartition(bucket, event.sender.id),
  );
  return { count: cookies.length };
});
// 第二期:按域拓取 cookie jar(renderer 拿去组装成 cookie 凭证存进 CredentialStore)。
ipcMain.handle("credentials:captureCookieJar", async (event, domain: string, bucket?: string) => {
  if (
    typeof domain !== "string" ||
    !domain.trim() ||
    domain.length > 253 ||
    domain.includes("\0")
  ) {
    throw new Error("credentials:captureCookieJar requires a domain");
  }
  const jar = await captureCookieJar(
    domain.trim(),
    requireRendererBrowserPartition(bucket, event.sender.id),
  );
  return { jar, count: jar.length };
});
// 第二期+:全量拓取当前 chat session 的浏览器分区所有 cookie(不按域过滤)。
ipcMain.handle("credentials:captureAllCookies", async (event, bucket?: string) => {
  const jar = await captureAllCookies(requireRendererBrowserPartition(bucket, event.sender.id));
  return { jar, count: jar.length };
});
// 第二期+:兜底拓取所有当前活着的浏览器面板 session,去重合并。
ipcMain.handle("credentials:captureAllCookiesAllSessions", async () => {
  return captureAllCookiesFromSessions(listGuestSessions());
});
// 第二期:切换账号 — 把某条 cookie 凭证的 jar 导回当前会话浏览器分区覆盖当前登录态,
// 然后广播 browser:reload 让浏览器面板刷新成该账号身份。
ipcMain.handle(
  "credentials:restoreCookieToBrowser",
  async (event, cwd: string, id: string, bucket?: string) => {
    const authorizedCwd = cwd ? await requireRendererProjectPath(cwd) : "";
    if (typeof id !== "string" || !id || id.length > 512 || id.includes("\0"))
      throw new Error("credentials:restoreCookieToBrowser requires id");
    const partition = requireRendererBrowserPartition(bucket, event.sender.id);
    await migrateCredentialStore(authorizedCwd || undefined);
    const cred = new CredentialStore(authorizedCwd || undefined).resolve(id);
    if (!cred || cred.type !== "cookie") throw new Error(`无 cookie 凭证: "${id}"`);
    let jar: ElectronCookieLike[];
    try {
      const parsed = JSON.parse(cred.secret ?? "[]");
      // A non-array (valid JSON but wrong shape) is corrupt too: silently falling
      // through to an empty jar would CLEAR the browser's cookies (clear mode) and
      // restore nothing — i.e. log the user out with no error. Treat it as corrupt.
      if (!Array.isArray(parsed)) throw new Error("not an array");
      jar = parsed as ElectronCookieLike[];
    } catch {
      throw new Error(`凭证「${cred.label}」的 cookie 数据损坏`);
    }
    const mode = cred.meta?.switchMode === "clear" ? "clear" : "merge";
    const { count } = await restoreCookiesToBrowser(jar, mode, partition);
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send("browser:reload", { bucket });
    }
    return { count };
  },
);
// 第二期+:独立窗口登录抓 cookie(解决内置 webview 登不上 Google/YouTube)。
// 开临时分区登录窗 → 用户点保存 → 读 cookie + 用户名 + 校验 → 关窗销毁分区。
// 只产出 jar/建议名/校验,存凭证由渲染层走 credentials:save。
ipcMain.handle(
  "credentials:loginCapture",
  async (_e, req: { url: string; platform?: string; fullCapture?: boolean }) => {
    if (!req || typeof req.url !== "string" || !req.url.trim()) {
      throw new Error("credentials:loginCapture requires a url");
    }
    return loginAndCaptureCookies({
      url: req.url.trim(),
      platform: req.platform,
      fullCapture: req.fullCapture === true,
    });
  },
);
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
  const result = uninstallPluginEntry(pluginName, marketplaceName);
  broadcastPluginCommandsChanged(mainWindows);
  return result;
});
ipcMain.handle("plugins:uninstallLocal", async (_e, name: string) => {
  const result = uninstallLocalPluginEntry(name);
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

// ─── Voice input (speech-to-text / 听写) ───
// Renderer records the mic, ships raw audio bytes here; we resolve the
// configured (or OpenAI-fallback) transcription provider and POST to its
// /audio/transcriptions. Pure request/response — NOT an agent tool.
async function transcribeConfiguredAudio(payload: {
  cwd: string;
  audio: Uint8Array;
  mimeType?: string;
  provider?: string;
  language?: string;
}): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  const resolved = resolveTranscribeProvider(payload.cwd, payload.provider);
  if (!resolved) return { ok: false, error: "no-audio-provider" };
  const mime = payload.mimeType?.trim() || "audio/webm";
  const ext = mime.includes("webm")
    ? "webm"
    : mime.includes("mp4") || mime.includes("m4a")
      ? "m4a"
      : mime.includes("wav")
        ? "wav"
        : "webm";
  return transcribe({
    audio: payload.audio,
    mimeType: mime,
    filename: `audio.${ext}`,
    model: resolved.model,
    creds: resolved.creds,
    language: payload.language,
    fetchImpl: fetch,
  });
}

async function ensureDesktopMicrophoneAccess(): Promise<{ granted: boolean }> {
  if (process.platform !== "darwin") return { granted: true };
  const status = systemPreferences.getMediaAccessStatus("microphone");
  if (status === "granted") return { granted: true };
  const granted = await systemPreferences.askForMediaAccess("microphone");
  return { granted };
}

ipcMain.handle(
  "stt:transcribe",
  async (
    _e,
    payload: {
      cwd: string;
      audio: ArrayBuffer;
      mimeType?: string;
      provider?: string;
      language?: string;
    },
  ): Promise<{ ok: true; text: string } | { ok: false; error: string }> => {
    const { cwd, audio, mimeType, provider, language } = payload ?? {};
    if (
      typeof cwd !== "string" ||
      !(audio instanceof ArrayBuffer) ||
      audio.byteLength === 0 ||
      audio.byteLength > 25 * 1024 * 1024 ||
      (mimeType !== undefined && (typeof mimeType !== "string" || mimeType.length > 256)) ||
      (provider !== undefined && (typeof provider !== "string" || provider.length > 512)) ||
      (language !== undefined && (typeof language !== "string" || language.length > 64))
    ) {
      return { ok: false, error: "bad-request" };
    }
    const authorizedCwd = await requireRendererProjectPath(cwd);
    return transcribeConfiguredAudio({
      cwd: authorizedCwd,
      audio: new Uint8Array(audio),
      ...(typeof mimeType === "string" ? { mimeType } : {}),
      ...(typeof provider === "string" ? { provider } : {}),
      ...(typeof language === "string" ? { language } : {}),
    });
  },
);
ipcMain.handle("stt:available", async (_e, cwd: string) => ({
  available: isTranscribeAvailable(await requireRendererProjectPath(cwd)),
}));
// What voice input will ACTUALLY use right now (configured connection vs reused
// OpenAI key vs none) — key already masked in core. Lets the connection page
// show the active/fallback config instead of looking unconfigured.
ipcMain.handle("stt:describe", async (_e, cwd: string) =>
  describeTranscribe(await requireRendererProjectPath(cwd)),
);
// macOS gates microphone access at the OS level (TCC). Ask BEFORE getUserMedia
// so the user gets the system prompt with our NSMicrophoneUsageDescription, and
// so a previously-denied state is reported back (renderer then shows guidance).
// No-op / always-true on other platforms. Returns whether access is granted.
ipcMain.handle("stt:ensureMicAccess", async (): Promise<{ granted: boolean }> => {
  return ensureDesktopMicrophoneAccess();
});
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
ipcMain.handle("panel-apps:previewLocal", async (_e, input: PanelAppSourceInput) =>
  previewLocalPanelAppForUi(input),
);
ipcMain.handle("panel-apps:discoverGit", async (_e, input: GitPanelAppSourceInput) =>
  discoverGitPanelAppsForUi(input),
);
ipcMain.handle("panel-apps:previewUpdate", async (_e, id: string) => {
  if (typeof id !== "string" || !id) throw new Error("panel-apps:previewUpdate requires id");
  return previewPanelAppUpdateForUi(id);
});
ipcMain.handle(
  "panel-apps:installLocal",
  async (
    _e,
    input: {
      source: PanelAppSourceInput;
      reviewToken: string;
      overwrite?: boolean;
    },
  ) => {
    if (!input || !input.source || typeof input.reviewToken !== "string") {
      throw new Error("panel-apps:installLocal requires source and reviewToken");
    }
    const result = await installLocalPanelAppForUi(input);
    if (result.ok) broadcastPanelAppsChanged(mainWindows);
    return result;
  },
);
ipcMain.handle(
  "panel-apps:installUpdate",
  async (_e, input: { id: string; reviewToken: string }) => {
    if (
      !input ||
      typeof input.id !== "string" ||
      !input.id ||
      typeof input.reviewToken !== "string"
    ) {
      throw new Error("panel-apps:installUpdate requires id and reviewToken");
    }
    const result = await installPanelAppUpdateForUi(input);
    if (result.ok) broadcastPanelAppsChanged(mainWindows);
    return result;
  },
);
ipcMain.handle("panel-apps:uninstall", async (_e, id: string, cwd?: string) => {
  if (typeof id !== "string" || !id || id.length > 512 || id.includes("\0")) {
    throw new Error("panel-apps:uninstall requires id");
  }
  if (cwd !== undefined && (typeof cwd !== "string" || !cwd)) {
    throw new Error("panel-apps:uninstall cwd must be a non-empty string");
  }
  const authorizedCwd = cwd ? await requireRendererProjectPath(cwd) : undefined;
  await uninstallPanelAppForUi(id);
  panelAppBridge.revokeAppId(id);
  try {
    const settings = (await readSettings("user")) ?? {};
    const disabled = (settings as { disabledPanelApps?: unknown }).disabledPanelApps;
    if (Array.isArray(disabled)) {
      await writeSettings("user", {
        disabledPanelApps: disabled.filter((candidate) => candidate !== id),
      });
    }
    if (authorizedCwd) {
      const projectSettings = (await readSettings("project", authorizedCwd)) ?? {};
      const bindings = Array.isArray(projectSettings.panelAppBindings)
        ? projectSettings.panelAppBindings.filter(
            (candidate): candidate is string => typeof candidate === "string" && candidate !== id,
          )
        : [];
      // Write the full surviving map, not `{[id]: null}`: deepMerge only honors
      // a null delete when the key already exists, so on a project without
      // panelAppOverrides the null lands in the file and the settings schema
      // then rejects it wholesale.
      const rawOverrides = projectSettings.panelAppOverrides;
      const overrides: Record<string, "inherit" | "on" | "off"> = {};
      if (rawOverrides && typeof rawOverrides === "object" && !Array.isArray(rawOverrides)) {
        for (const [key, value] of Object.entries(rawOverrides as Record<string, unknown>)) {
          if (key === id) continue;
          if (value === "inherit" || value === "on" || value === "off") overrides[key] = value;
        }
      }
      await writeSettings(
        "project",
        {
          panelAppBindings: bindings,
          panelAppOverrides: overrides,
        },
        authorizedCwd,
      );
    }
  } catch (error) {
    dlog("main", "panel_app.settings_cleanup_failed", {
      id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  broadcastPanelAppsChanged(mainWindows);
});
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
/** Convert an installed theme to the renderer ThemePack shape with cstheme:// urls. */
function installedThemeToPack(theme: InstalledTheme): InstalledThemePack {
  const asset = (rel?: string): string | undefined =>
    rel ? themeAssetUrl(theme.id, rel) : undefined;
  const pet: NonNullable<InstalledThemePack["pet"]> = {};
  if (theme.pet.idle) pet.idle = asset(theme.pet.idle)!;
  if (theme.pet.running) pet.running = asset(theme.pet.running)!;
  if (theme.pet.alert) pet.alert = asset(theme.pet.alert)!;
  if (theme.pet.walk?.length) pet.walk = theme.pet.walk.map((rel) => asset(rel)!);
  const wp = theme.wallpaper;
  return {
    id: theme.id,
    name: theme.name,
    swatch: theme.colors.light["--cs-primary"] ?? theme.colors.dark["--cs-primary"] ?? "0 0% 50%",
    colors: theme.colors,
    ...(Object.keys(pet).length ? { pet } : {}),
    ...(wp
      ? {
          wallpaper: {
            ...(asset(wp.light) ? { light: asset(wp.light) } : {}),
            ...(asset(wp.dark) ? { dark: asset(wp.dark) } : {}),
            ...(wp.opacity !== undefined ? { opacity: wp.opacity } : {}),
          },
        }
      : {}),
    source: "installed",
  };
}

ipcMain.handle("themes:list", async () => {
  const themes = await listInstalledThemes();
  return themes.map(installedThemeToPack);
});
ipcMain.handle(
  "themes:pickAndPreview",
  async (): Promise<
    { cancelled: true } | { cancelled: false; path: string; preview: ThemePreview }
  > => {
    const win = BrowserWindow.getFocusedWindow();
    const picked = win
      ? await dialog.showOpenDialog(win, {
          title: "选择主题包目录",
          properties: ["openDirectory"],
        })
      : await dialog.showOpenDialog({ title: "选择主题包目录", properties: ["openDirectory"] });
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
ipcMain.handle("files:searchProject", async (_e, projectId: string, query: string) => {
  const project = await requireRendererProject(projectId);
  const q = typeof query === "string" ? query : "";
  if (q.length > 512) throw new Error("files:searchProject query is too long");
  return searchProjectFiles(project.roots, q);
});
ipcMain.handle("session:content-search", async (_e, ...args: unknown[]) => {
  const query = args.length === 1 ? args[0] : undefined;
  if (typeof query !== "string") throw new Error("invalid content search query");
  const trimmed = query.trim();
  if (trimmed.length < 2 || trimmed.length > 128) throw new Error("invalid content search query");
  return searchSessionTranscripts(sessionsRoot(), trimmed, { budgetMs: 5_000 });
});

async function runClaimBoundAttachmentOperation<T>(
  ownerId: number,
  payload: { cwd?: string; sessionId?: string; quickChatClaimId?: string },
  operation: () => Promise<T>,
): Promise<T> {
  const sessionId = payload.sessionId!;
  if (!sessionId.startsWith("qchat-")) return operation();

  // Quick-chat disk writes share the same ownership generation as fork/GC.
  // Missing/stale claims fail before IO; cleanup tombstones the claim and waits
  // for already-started operations to settle before deleting the session.
  assertQuickChatClaim(sessionId, payload.quickChatClaimId);
  const claimId = payload.quickChatClaimId!;
  if (!quickChatOwnership.beginOperation(sessionId, ownerId, claimId)) {
    throw new Error("quick-chat attachment claim is no longer active");
  }

  let result: T | undefined;
  let operationError: unknown;
  try {
    result = await operation();
  } catch (error) {
    operationError = error;
  }
  const settled = await quickChatOwnership.settleOperation(
    sessionId,
    ownerId,
    claimId,
    async () => {
      await deleteDesktopSession(sessionId);
      if (payload.cwd) {
        // Worktree cwd may not be in the project registry scanned by the
        // generic session cleanup, so remove the exact late-write directory.
        await cleanupSessionAttachments(payload.cwd, sessionId).catch(() => undefined);
      }
    },
  );
  if (operationError) throw operationError;
  if (!settled.active) {
    throw new Error("quick-chat attachment result arrived after cleanup");
  }
  return result as T;
}

ipcMain.handle(
  "attachments:stageImageDataUrl",
  async (
    event,
    payload: {
      cwd?: string;
      sessionId?: string;
      name?: string;
      mime?: string;
      dataUrl?: string;
      origin?: string;
      quickChatClaimId?: string;
    },
  ) => {
    if (!payload || typeof payload !== "object") {
      throw new Error("attachments:stageImageDataUrl requires payload");
    }
    if (typeof payload.cwd !== "string")
      throw new Error("attachments:stageImageDataUrl requires cwd");
    if (typeof payload.sessionId !== "string") {
      throw new Error("attachments:stageImageDataUrl requires sessionId");
    }
    if (typeof payload.dataUrl !== "string") {
      throw new Error("attachments:stageImageDataUrl requires dataUrl");
    }
    const cwd = await requireRendererProjectPath(payload.cwd);
    if (payload.dataUrl.length > Math.ceil((10 * 1024 * 1024 * 4) / 3) + 1_024) {
      throw new Error("attachments:stageImageDataUrl exceeds the encoded size limit");
    }
    const origin =
      payload.origin === "paste" ||
      payload.origin === "os-drop" ||
      payload.origin === "file-panel" ||
      payload.origin === "picker" ||
      payload.origin === "mention" ||
      payload.origin === "generated" ||
      payload.origin === "tool"
        ? payload.origin
        : "paste";
    const authorizedPayload = { ...payload, cwd };
    return runClaimBoundAttachmentOperation(event.sender.id, authorizedPayload, () =>
      stageImageDataUrl({
        cwd,
        sessionId: payload.sessionId!,
        name: payload.name,
        mime: payload.mime,
        dataUrl: payload.dataUrl!,
        origin,
      }),
    );
  },
);
ipcMain.handle(
  "attachments:cleanup",
  async (_e, payload: { cwd?: string; sessionId?: string; now?: number }) => {
    if (!payload || typeof payload.cwd !== "string") {
      throw new Error("attachments:cleanup requires cwd");
    }
    const cwd = await requireRendererProjectPath(payload.cwd);
    return cleanupAttachments({
      cwd,
      sessionId: typeof payload.sessionId === "string" ? payload.sessionId : undefined,
    });
  },
);
ipcMain.handle("attachments:inspect", async (_e, payload: { cwd?: string; sessionId?: string }) => {
  if (!payload || typeof payload.cwd !== "string") {
    throw new Error("attachments:inspect requires cwd");
  }
  const cwd = await requireRendererProjectPath(payload.cwd);
  return listRecentAttachments({
    cwd,
    sessionId: typeof payload.sessionId === "string" ? payload.sessionId : undefined,
  });
});
ipcMain.handle(
  "attachments:markSent",
  async (
    event,
    payload: {
      cwd?: string;
      sessionId?: string;
      attachments?: Array<Parameters<typeof markAttachmentsSent>[2][number]>;
      quickChatClaimId?: string;
    },
  ) => {
    if (!payload || typeof payload.cwd !== "string" || typeof payload.sessionId !== "string") {
      throw new Error("attachments:markSent requires cwd and sessionId");
    }
    const cwd = await requireRendererProjectPath(payload.cwd);
    const attachments = Array.isArray(payload.attachments) ? payload.attachments : [];
    if (attachments.length > 32) throw new Error("too many attachments to mark sent");
    const authorizedPayload = { ...payload, cwd };
    return runClaimBoundAttachmentOperation(event.sender.id, authorizedPayload, async () => {
      await markAttachmentsSent(cwd, payload.sessionId!, attachments);
      return { ok: true } as const;
    });
  },
);
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

ipcMain.handle("agents:list", async (_e, target: RendererConfigurationTarget | null) =>
  listAgents(await rendererOptionalConfigurationCwd(target, "")),
);
ipcMain.handle(
  "agents:read",
  async (_e, target: RendererConfigurationTarget | null, filePath: unknown) =>
    readAgentBody(await requireRendererListedAgentPath(target, filePath)),
);

ipcMain.handle(
  "images:readDataUrl",
  async (
    _e,
    payload: { absPath?: unknown; cwd?: unknown; sessionId?: unknown },
  ): Promise<string | null> => {
    const cwd =
      typeof payload?.cwd === "string" && payload.cwd
        ? await requireRendererProjectPath(payload.cwd)
        : undefined;
    return readImageDataUrl(typeof payload?.absPath === "string" ? payload.absPath : "", {
      cwd,
      sessionId: typeof payload?.sessionId === "string" ? payload.sessionId : undefined,
    });
  },
);

// Save an image to a user-chosen location (Lightbox / attachment "download").
// Accepts the data URL the renderer already holds (works for generated images,
// pasted/dragged attachments, and file-backed thumbnails alike). Returns the
// saved path, or null if the user cancelled the dialog.
ipcMain.handle(
  "images:save",
  async (e, src: string, opts?: { name?: string; mime?: string }): Promise<string | null> => {
    if (typeof src !== "string" || !src) throw new Error("images:save requires src");
    if (src.length > Math.ceil((10 * 1024 * 1024 * 4) / 3) + 1_024) {
      throw new Error("images:save exceeds the encoded size limit");
    }
    const parsed = parseDataUrl(src);
    if (!parsed) throw new Error("images:save: src is not a data URL");
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const suggested = suggestImageFilename({
      name: opts?.name ?? null,
      mime: opts?.mime ?? parsed.mime,
      stamp,
    });
    const win = BrowserWindow.fromWebContents(e.sender) ?? undefined;
    const result = win
      ? await dialog.showSaveDialog(win, { defaultPath: suggested })
      : await dialog.showSaveDialog({ defaultPath: suggested });
    if (result.canceled || !result.filePath) return null;
    await writeFile(result.filePath, parsed.buffer);
    return result.filePath;
  },
);
ipcMain.handle(
  "agents:save",
  async (
    _e,
    def: AgentDefinition,
    opts?: { scope?: "user" | "project"; target?: RendererConfigurationTarget },
  ) => {
    if (!def || typeof def !== "object") throw new Error("agents:save requires def");
    if (typeof def.name !== "string" || typeof def.description !== "string")
      throw new Error("agents:save: name and description are required");
    if (opts?.scope !== undefined && opts.scope !== "user" && opts.scope !== "project") {
      throw new Error("invalid agent scope");
    }
    if (opts) {
      rejectUnexpectedRendererKeys(
        opts as Record<string, unknown>,
        ["scope", "target"],
        "agents:save",
      );
    }
    if (opts?.scope === "project" && !opts.target) {
      throw new Error("project agent save requires stable authority");
    }
    if (opts?.scope !== "project" && opts?.target) {
      throw new Error("user agent save does not accept project authority");
    }
    const cwd = opts?.target ? await rendererConfigurationCwd(opts.target) : undefined;
    return saveAgent(def, { scope: opts?.scope, cwd });
  },
);
ipcMain.handle(
  "agents:delete",
  async (
    _e,
    name: string,
    opts?: { scope?: "user" | "project"; target?: RendererConfigurationTarget },
  ) => {
    if (typeof name !== "string" || !name) throw new Error("agents:delete requires name");
    if (opts?.scope !== undefined && opts.scope !== "user" && opts.scope !== "project") {
      throw new Error("invalid agent scope");
    }
    if (opts) {
      rejectUnexpectedRendererKeys(
        opts as Record<string, unknown>,
        ["scope", "target"],
        "agents:delete",
      );
    }
    if (opts?.scope === "project" && !opts.target) {
      throw new Error("project agent delete requires stable authority");
    }
    if (opts?.scope !== "project" && opts?.target) {
      throw new Error("user agent delete does not accept project authority");
    }
    const cwd = opts?.target ? await rendererConfigurationCwd(opts.target) : undefined;
    return deleteAgent(name, { scope: opts?.scope, cwd });
  },
);

const githubSkillReviews = new GithubSkillReviewStore();

ipcMain.handle("skills:inspectGithub", async (event, url: string, existingNames?: unknown) => {
  if (typeof url !== "string" || !url || url.length > 8_192 || url.includes("\0")) {
    throw new Error("skills:inspectGithub requires url");
  }
  if (!Array.isArray(existingNames) && existingNames !== undefined) {
    throw new Error("skills:inspectGithub existingNames must be an array");
  }
  const names = existingNames ?? [];
  if (
    names.length > 4_096 ||
    names.some((name) => typeof name !== "string" || name.length > 512 || name.includes("\0"))
  ) {
    throw new Error("skills:inspectGithub existingNames are invalid");
  }
  return githubSkillReviews.issue(event.sender.id, await inspectRepo(url, names as string[]));
});

ipcMain.handle("skills:installFromGithub", async (event, input: unknown) => {
  if (!input || typeof input !== "object") {
    throw new Error("skills:installFromGithub requires { inspection, selected, scope }");
  }
  const i = input as Omit<InstallFromGithubInput, "cwd"> & {
    target?: RendererConfigurationTarget;
  };
  rejectUnexpectedRendererKeys(
    input as Record<string, unknown>,
    ["inspection", "selected", "scope", "target", "installName"],
    "skills:installFromGithub",
  );
  if (!i.inspection || !i.selected) throw new Error("missing inspection/selected");
  if (i.scope !== "user" && i.scope !== "project") throw new Error("invalid scope");
  if (
    i.installName !== undefined &&
    (typeof i.installName !== "string" ||
      i.installName.length > 512 ||
      i.installName.includes("\0"))
  ) {
    throw new Error("invalid skill install name");
  }
  if (i.scope === "project" && !i.target) {
    throw new Error("project skill install requires stable authority");
  }
  if (i.scope === "user" && i.target) {
    throw new Error("user skill install does not accept project authority");
  }
  const cwd = i.target ? await rendererConfigurationCwd(i.target) : undefined;
  const reviewToken = (i.inspection as { reviewToken?: unknown }).reviewToken;
  const reviewed = githubSkillReviews.consume(event.sender.id, reviewToken, i.selected);
  const { target: _target, ...installInput } = i;
  return installFromGithub({
    ...installInput,
    inspection: reviewed.inspection,
    selected: reviewed.selected,
    cwd,
  });
});

ipcMain.handle(
  "skills:installLocal",
  async (
    _e,
    sourceDir: string,
    scope: "user" | "project",
    target: RendererConfigurationTarget | null,
    name?: string,
  ) => {
    if (typeof sourceDir !== "string" || !sourceDir) {
      throw new Error("skills:installLocal requires sourceDir");
    }
    if (scope !== "user" && scope !== "project") throw new Error("invalid scope");
    if (scope === "project" && target === null) {
      throw new Error("project skill install requires stable authority");
    }
    if (scope === "user" && target !== null) {
      throw new Error("user skill install does not accept project authority");
    }
    const authorizedCwd = target === null ? undefined : await rendererConfigurationCwd(target);
    return installSkillFromDirectory(sourceDir, scope, authorizedCwd, name);
  },
);

ipcMain.handle("mcp:probe", async (_e, raw: unknown, force?: boolean) => {
  if (!Array.isArray(raw)) return [];
  const configs = raw.filter(
    (x): x is McpServerConfig =>
      !!x && typeof x === "object" && typeof (x as McpServerConfig).name === "string",
  );
  return probeMcpServers(configs, {
    force: Boolean(force),
    oauthService: getMcpOAuthService(),
  });
});

ipcMain.handle(
  "mcp:listMerged",
  async (
    _e,
    rawBase: unknown,
    rawDisabledPlugins?: unknown,
    target?: RendererConfigurationTarget | null,
  ) => {
    const base =
      rawBase && typeof rawBase === "object" ? (rawBase as Record<string, McpServerConfig>) : {};
    const rawList = Array.isArray(rawDisabledPlugins)
      ? rawDisabledPlugins.filter((x): x is string => typeof x === "string")
      : [];
    // Fold project capabilityOverrides over the renderer's raw global list when
    // a cwd is known — the pluginDisabled flag must reflect the EFFECTIVE state
    // (能力总览 project "on" overrides global off), matching the engine's merge.
    const cwd = target == null ? undefined : await rendererConfigurationCwd(target);
    const disabledPlugins = cwd
      ? computeEffectiveDisabledLists(new SettingsManager(cwd, "full"), cwd).disabledPlugins
      : rawList;
    // Merge with ALL plugins (no disabled filter): an installed plugin's MCP
    // should be VISIBLE in the settings page even while the plugin is disabled
    // (feedback: 装了就该展示,而不是打开插件才出现). The engine's own connect
    // path still filters disabledPlugins, so a disabled plugin's server is
    // listed-but-inert; we mark it `pluginDisabled` for the UI.
    const disabledSet = new Set(disabledPlugins);
    // Plugin-MCP overrides live globally (user scope), independent of the active
    // settings scope — read them here and let the merge layer them onto plugin
    // servers so the listed env/credential reflects the EFFECTIVE connect config.
    const userSettings = ((await readSettings("user").catch(() => null)) ?? {}) as {
      mcpServerOverrides?: Record<string, McpServerConfig>;
    };
    const overrides = (userSettings.mcpServerOverrides ?? {}) as Record<string, McpServerConfig>;
    const merged = mergePluginMcpServers(base, [], overrides);
    return Object.fromEntries(
      Object.entries(merged).map(([name, cfg]) => {
        const fromSettings = Object.prototype.hasOwnProperty.call(base, name);
        const colon = name.indexOf(":");
        const owner = !fromSettings && colon > 0 ? name.slice(0, colon) : undefined;
        return [
          name,
          {
            ...cfg,
            name,
            source: fromSettings ? "settings" : "plugin",
            editable: fromSettings,
            pluginDisabled: owner !== undefined && disabledSet.has(owner),
            // Flag a plugin server that currently carries a user override so the
            // UI can badge it. (User-added servers never use the override layer.)
            hasOverride: !fromSettings && Object.prototype.hasOwnProperty.call(overrides, name),
          },
        ];
      }),
    );
  },
);

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

ipcMain.handle("mcp:invalidate", async (_e, name?: string) => {
  invalidateMcpProbeCache(typeof name === "string" ? name : undefined);
});

ipcMain.handle("search:probe", async (_e, raw: unknown) => {
  if (!raw || typeof raw !== "object") {
    throw new Error("search:probe requires { provider, apiKey?, baseUrl? }");
  }
  const r = raw as SearchProbeInput;
  if (r.provider !== "serper" && r.provider !== "tavily" && r.provider !== "searxng") {
    throw new Error(`invalid provider: ${r.provider}`);
  }
  return probeSearch(r);
});

ipcMain.handle("image:probe", async (_e, raw: unknown) => {
  if (!raw || typeof raw !== "object") {
    throw new Error("image:probe requires { kind, apiKey?, baseUrl?, model? }");
  }
  const r = raw as ImageProbeInput;
  if (typeof r.kind !== "string" || !r.kind) {
    throw new Error("image:probe requires a provider kind");
  }
  return probeImage(r);
});

ipcMain.handle("catalog:list", async () => getMergedCatalog());

ipcMain.handle("catalog:save", async (_e, entry: unknown) =>
  saveCatalogEntry(entry, { path: userCatalogPath(), stamp: String(Date.now()) }),
);
ipcMain.handle("catalog:delete", async (_e, id: string) =>
  deleteUserCatalogEntry(id, { path: userCatalogPath(), stamp: String(Date.now()) }),
);
ipcMain.handle("catalog:origins", async () => catalogEntryOrigins());

ipcMain.handle("models:resolve-meta", async (_e, models: unknown, providers: unknown) => {
  if (!Array.isArray(models) || !Array.isArray(providers)) return [];
  return resolveModelMeta(models as never, providers as never);
});

ipcMain.handle("models:reasoning-control", async (_e, rawKind: unknown, rawModel: unknown) => {
  const kind: ProviderKindName =
    typeof rawKind === "string" && Object.prototype.hasOwnProperty.call(PROVIDER_KINDS, rawKind)
      ? (rawKind as ProviderKindName)
      : "custom";
  const model = typeof rawModel === "string" ? rawModel : "";
  return reasoningControlFor(kind, model);
});

ipcMain.handle("models:list", async (_e, rawProvider: unknown, refresh?: boolean) => {
  const provider =
    rawProvider && typeof rawProvider === "object" ? (rawProvider as Record<string, unknown>) : {};
  const rawKind = typeof provider.kind === "string" ? provider.kind : "custom";
  const kind = Object.prototype.hasOwnProperty.call(PROVIDER_KINDS, rawKind)
    ? (rawKind as ProviderKindName)
    : "custom";
  const meta = PROVIDER_KINDS[kind];
  const rawBaseUrl =
    typeof provider.baseUrl === "string" && provider.baseUrl.trim()
      ? provider.baseUrl.trim()
      : meta.defaultBaseUrl;
  const baseUrl = kind === "ollama" ? rawBaseUrl.replace(/\/v1\/?$/, "") : rawBaseUrl;
  return fetchModelList(
    {
      key: typeof provider.key === "string" && provider.key ? provider.key : kind,
      kind,
      baseUrl,
      apiKey: typeof provider.apiKey === "string" ? provider.apiKey : undefined,
      modelsPath: typeof provider.modelsPath === "string" ? provider.modelsPath : undefined,
    },
    { cacheDir: defaultCacheDir(), refresh: refresh === true },
  );
});

ipcMain.handle("updater:check", async () => checkForUpdate());
ipcMain.handle("updater:download", async () => downloadUpdate());
ipcMain.handle("updater:install", async () => quitAndInstall());
ipcMain.handle("updater:status", async () => getLastStatus());
ipcMain.handle("app:version", () => app.getVersion());

// ── Mobile Web Remote ───────────────────────────────────────────────────────
// In-flight mutex for mobileRemote:start. Without it, a concurrent second
// start (double-click / multi-window / IPC re-entry) sees an already-running
// tunnel child, throws, and its catch UNCONDITIONALLY tears down the FIRST
// call's tunnel — so both fail. Reusing the in-flight promise makes concurrent
// starts idempotent: the second caller awaits the first's result instead of
// launching a competing start.
let mobileRemoteStartInFlight: Promise<{
  url: string;
  pairingUrl: string;
  expiresAt: number;
  mode: "tunnel" | "lan";
}> | null = null;

async function startMobileRemote(opts?: {
  mode?: "lan" | "tunnel";
}): Promise<MobileRemoteOpenResult> {
  if (mobileRemoteStartInFlight) return mobileRemoteStartInFlight;
  const run = (async () => {
    const mode = opts?.mode ?? "lan";
    const existing = mobileRemote.status();
    const reusableTunnelUrl = mode === "tunnel" ? tunnelManager.publicUrl() : undefined;
    if (
      existing?.mode === mode &&
      ((mode === "lan" && !tunnelManager.isRunning()) ||
        (tunnelManager.isConnected() && reusableTunnelUrl))
    ) {
      if (reusableTunnelUrl) mobileRemote.setPublicBaseUrl(reusableTunnelUrl);
      const pairing = mobileRemote.createPairingUrl();
      return {
        url: reusableTunnelUrl ?? existing.url,
        pairingUrl: pairing.url,
        expiresAt: pairing.expiresAt,
        mode,
      };
    }
    if (existing || tunnelManager.isRunning()) {
      await Promise.allSettled([tunnelManager.stop(), mobileRemote.stop()]);
    }
    if (mode === "tunnel") {
      // Public tunnel: passcode MUST be set first (UI also disables the button).
      if (!accessPasscode.isSet()) {
        throw new Error("请先设置访问口令,再开启公网模式");
      }
      // Ensure cloudflared is present (no-op if already downloaded).
      await cloudflaredBinary.ensureBinary();
      // Bind loopback; cloudflared connects to 127.0.0.1.
      const started = await mobileRemote.start({
        mode: "tunnel",
        host: "lan",
        port: 0,
        passcode: accessPasscode,
      });
      try {
        const { url } = await tunnelManager.start(started.port);
        mobileRemote.setPublicBaseUrl(url);
        const pairing = mobileRemote.createPairingUrl();
        return {
          url,
          pairingUrl: pairing.url,
          expiresAt: pairing.expiresAt,
          mode: "tunnel" as const,
        };
      } catch (err) {
        // Tunnel failed (binary error / 15s URL timeout): tear everything down
        // and surface a friendly error so the UI returns to the off state.
        await Promise.allSettled([tunnelManager.stop(), mobileRemote.stop()]);
        throw new Error(`公网隧道启动失败:${err instanceof Error ? err.message : String(err)}`, {
          cause: err,
        });
      }
    }
    // LAN mode (unchanged): bind the Mac's real LAN IP so a phone on the same
    // Wi-Fi can reach it (falls back to localhost). Never 0.0.0.0.
    const started = await mobileRemote.start({ host: "lan", port: 0 });
    const pairing = mobileRemote.createPairingUrl();
    return {
      url: started.url,
      pairingUrl: pairing.url,
      expiresAt: pairing.expiresAt,
      mode: "lan" as const,
    };
  })();
  mobileRemoteStartInFlight = run;
  try {
    return await run;
  } finally {
    if (mobileRemoteStartInFlight === run) mobileRemoteStartInFlight = null;
  }
}

async function stopMobileRemote(): Promise<void> {
  await Promise.all([tunnelManager.stop(), mobileRemote.stop()]);
}

function createMobileRemotePairingUrl(): { pairingUrl: string; expiresAt: number } {
  const pairing = mobileRemote.createPairingUrl();
  return { pairingUrl: pairing.url, expiresAt: pairing.expiresAt };
}

function getMobileRemoteGatewayStatus(): MobileRemoteGatewayStatus {
  const status = mobileRemote.status();
  return {
    running: Boolean(status),
    url:
      status?.mode === "tunnel"
        ? tunnelManager.isConnected()
          ? tunnelManager.publicUrl()
          : undefined
        : status?.url,
    mode: status?.mode,
    tunnelRunning: tunnelManager.isRunning(),
    tunnelConnected: tunnelManager.isConnected(),
    passcodeSet: accessPasscode.isSet(),
    onlineDeviceCount: mobileRemote.onlineDeviceIds().length,
  };
}

ipcMain.handle("mobileRemote:start", async (_e, opts?: { mode?: "lan" | "tunnel" }) =>
  startMobileRemote(opts),
);
ipcMain.handle("mobileRemote:stop", async () => stopMobileRemote());
// Mint a fresh pairing URL on the already-running host. Lets the UI regenerate
// the QR after a settings-page remount (pairingUrl is renderer-local state and
// is lost on navigation) without restarting the host.
ipcMain.handle("mobileRemote:pairingUrl", async () => createMobileRemotePairingUrl());
ipcMain.handle("mobileRemote:status", async () => getMobileRemoteGatewayStatus());
ipcMain.handle("mobileRemote:listDevices", async () => mobileDevices.listDevices());
ipcMain.handle("mobileRemote:revokeDevice", async (_e, id: string) => mobileDevices.revoke(id));
ipcMain.handle("mobileRemote:removeDevice", async (_e, id: string) => mobileDevices.remove(id));
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
  async (_e, input: { requestId?: unknown; sessionId?: unknown; approved?: unknown }) => {
    const requestId = typeof input?.requestId === "string" ? input.requestId : "";
    if (!requestId) return false;
    mobileOrchestrator.broadcastApprovalResolved({
      requestId,
      sessionId: typeof input?.sessionId === "string" ? input.sessionId : undefined,
      approved: typeof input?.approved === "boolean" ? input.approved : undefined,
    });
    return true;
  },
);

const knownGitRoots = new Set<string>();

registerProjectAuthorityIpc({
  ipcMain,
  getAllWindows: () => BrowserWindow.getAllWindows(),
  showOpenDialog: (options) => dialog.showOpenDialog(options),
  applyGitPathFromSettings,
  projectStore,
  getBridge: () => bridge,
  getTrust,
  assertSessionId: assertDesktopSessionId,
  trackGitRoot: (root) => knownGitRoots.add(root),
  broadcastMobileProjects: () => mobileOrchestrator.broadcastProjects(),
  getGitStatus,
  getGitBranches,
  revealInFinder,
  openPath,
});

// ── Rooms (desktop side; same RoomManager the phone uses → dual-ended) ──────
ipcMain.handle("rooms:list", async () =>
  roomManager.listRooms().map((room) => mobileOrchestrator.roomToPublic(room)),
);
ipcMain.handle("rooms:projects", async () => mobileOrchestrator.projectList());
ipcMain.handle(
  "rooms:create",
  async (
    _e,
    input: {
      name?: string;
      cwd: string;
      kind?: "claude-code" | "codex";
      permissionMode?: "default" | "acceptEdits" | "bypassPermissions";
    },
  ) => {
    const cwd = await requireRendererProjectPath(input?.cwd);
    if (input.name !== undefined && (typeof input.name !== "string" || input.name.length > 512)) {
      throw new Error("invalid room name");
    }
    const permissionMode = await resolveRoomPermissionMode(cwd, input.permissionMode);
    const room = roomManager.createRoom({
      name: input.name,
      cwd,
      kind: input.kind,
      permissionMode,
    });
    return mobileOrchestrator.roomToPublic(room);
  },
);
ipcMain.handle("rooms:open", async (_e, roomId: string) => roomManager.open(roomId));
ipcMain.handle("rooms:close", async (_e, roomId: string) => {
  roomManager.close(roomId);
});
ipcMain.handle("rooms:send", async (_e, roomId: string, text: string) => {
  if (typeof text !== "string" || text.length > MAX_EXTERNAL_RUNTIME_TEXT_CHARS) {
    throw new Error("invalid room message");
  }
  return roomManager.send(roomId, text);
});
ipcMain.handle("rooms:history", async (_e, roomId: string, sinceSeq?: number) =>
  roomManager.getMessages(roomId, sinceSeq ?? 0),
);

// ── CC rooms (external `claude` CLI orchestration) ──────────────────────────
ipcMain.handle("ccRoom:probe", async (_e, force?: boolean) => probeClaudeCli(Boolean(force)));
ipcMain.handle("ccRoom:codexProbe", async (_e, force?: boolean) => probeCodexCli(Boolean(force)));
// Bounded by default (recent 2 weeks AND ≤20) so a project with lots of history
// doesn't deep-read every session file on open. `all:true` returns everything
// (the "load more" path). `total` lets the UI show how many are hidden.
ipcMain.handle("ccRoom:listSessions", async (_e, cwd: string, all?: boolean) => {
  cwd = await requireRendererProjectPath(cwd);
  const opts = all ? {} : { limit: DEFAULT_DISCOVER_LIMIT, sinceMs: DEFAULT_DISCOVER_SINCE_MS };
  const sessions = discoverRelatedSessions("claude", cwd, opts);
  const total = all ? sessions.length : countRelatedSessions("claude", cwd);
  return { sessions, total };
});
ipcMain.handle("ccRoom:listCodexSessions", async (_e, cwd: string, all?: boolean) => {
  cwd = await requireRendererProjectPath(cwd);
  const opts = all ? {} : { limit: DEFAULT_DISCOVER_LIMIT, sinceMs: DEFAULT_DISCOVER_SINCE_MS };
  const sessions = discoverRelatedSessions("codex", cwd, opts);
  const total = all ? sessions.length : countRelatedSessions("codex", cwd);
  return { sessions, total };
});
ipcMain.handle(
  "ccRoom:openSession",
  async (
    _e,
    claudeSessionId: string,
    cwd: string,
    mode: "default" | "acceptEdits" | "bypassPermissions",
    kind?: "claude-code" | "codex",
  ) => {
    cwd = await requireRendererProjectPath(cwd);
    return roomManager.openForSession(claudeSessionId, cwd, mode, kind ?? "claude-code");
  },
);
ipcMain.handle(
  "ccRoom:openLinkedSession",
  async (_e, externalSessionId: unknown, cwd: unknown, kind: unknown) =>
    openLinkedSessionFromIpc(
      roomManager,
      externalSessionId,
      await requireRendererProjectPath(cwd),
      kind,
    ),
);
ipcMain.handle(
  "ccRoom:takeOverLinkedSession",
  async (_e, roomId: unknown, externalSessionId: unknown, cwd: unknown, kind: unknown) =>
    takeOverLinkedSessionFromIpc(
      roomManager,
      roomId,
      externalSessionId,
      await requireRendererProjectPath(cwd),
      kind,
    ),
);
const transcriptCleanupSenders = new Set<number>();
ipcMain.handle(
  "ccRoom:subscribeTranscript",
  async (
    event,
    roomId: string,
    cwd: string,
    sessionId: string,
    kind: "claude-code" | "codex",
    limit: number,
  ) => {
    cwd = await requireRendererProjectPath(cwd);
    if (!mobileOrchestrator.roomMatchesTranscript(roomId, cwd, sessionId, kind)) {
      throw new Error("cc-room transcript subscription does not match the opened room");
    }
    const senderId = event.sender.id;
    const subscriberId = `desktop:${senderId}`;
    if (!transcriptCleanupSenders.has(senderId)) {
      transcriptCleanupSenders.add(senderId);
      event.sender.once("destroyed", () => {
        transcriptCleanupSenders.delete(senderId);
        transcriptSubscriptions?.unsubscribeSubscriber(subscriberId);
      });
    }
    return transcriptSubscriptions!.subscribe({
      subscriberId,
      roomId,
      cwd,
      sessionId,
      kind,
      limit,
    });
  },
);
ipcMain.handle("ccRoom:unsubscribeTranscript", async (event, roomId: string) => {
  transcriptSubscriptions!.unsubscribe(`desktop:${event.sender.id}`, roomId);
});
ipcMain.handle("ccRoom:send", async (_e, roomId: string, text: string) => {
  if (typeof text !== "string" || text.length > MAX_EXTERNAL_RUNTIME_TEXT_CHARS) {
    throw new Error("invalid room message");
  }
  return roomManager.send(roomId, text);
});
ipcMain.handle(
  "ccRoom:respondApproval",
  async (
    _e,
    roomId: string,
    requestId: string,
    decision:
      | { behavior: "allow"; updatedInput?: unknown; answer?: string }
      | { behavior: "deny"; message: string },
  ) => approvalBridge.respond(roomId, requestId, decision),
);
ipcMain.handle("ccRoom:roomHistory", async (_e, roomId: string, sinceSeq?: number) =>
  roomManager.getMessages(roomId, sinceSeq ?? 0),
);
ipcMain.handle("ccRoom:readHistory", async (_e, cwd: string, sessionId: string, limit: number) => {
  cwd = await requireRendererProjectPath(cwd);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new Error("invalid limit");
  return readRecentHistory(cwd, sessionId, limit);
});
ipcMain.handle(
  "ccRoom:readCodexHistory",
  async (_e, cwd: string, threadId: string, limit: number) => {
    cwd = await requireRendererProjectPath(cwd);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new Error("invalid limit");
    return readCodexRecentHistory(cwd, threadId, limit);
  },
);
ipcMain.handle("ccRoom:closeSession", async (_e, roomId: string) => {
  transcriptSubscriptions?.endRoom(roomId);
  roomManager.close(roomId);
});

// Remaining CC/Codex subscription quota. Reads tokens from Keychain / ~/.codex
// then hits each vendor's usage source. `provider` restricts the lookup
// ("codex" is free; "claude" sends a ~1-token probe). Never throws — a failed
// lookup lands in the per-provider `error` field.
ipcMain.handle(
  "quota:get",
  async (_e, provider?: "claude" | "codex" | "both"): Promise<QuotaResult> => {
    const creds = await resolveQuotaCredentials();
    const providers: ("claude" | "codex")[] =
      provider === "claude" ? ["claude"] : provider === "codex" ? ["codex"] : ["claude", "codex"];
    return checkQuota({ creds, providers });
  },
);

ipcMain.handle("dialog:pickSkillDir", async (): Promise<{ path: string; name: string } | null> => {
  const res = await dialog.showOpenDialog({
    title: "选择 Skill 文件夹",
    properties: ["openDirectory"],
  });
  if (res.canceled || res.filePaths.length === 0) return null;
  const selected = res.filePaths[0];
  return { path: selected, name: basename(selected) };
});

ipcMain.handle(
  "dialog:pickPluginSource",
  async (
    _e,
    kind: "dir" | "zip",
  ): Promise<{ kind: "dir" | "zip"; path: string; name: string } | null> => {
    const res =
      kind === "zip"
        ? await dialog.showOpenDialog({
            title: "选择插件压缩包",
            properties: ["openFile"],
            filters: [{ name: "Zip 压缩包", extensions: ["zip"] }],
          })
        : await dialog.showOpenDialog({
            title: "选择插件文件夹",
            properties: ["openDirectory"],
          });
    if (res.canceled || res.filePaths.length === 0) return null;
    const selected = res.filePaths[0];
    // For a zip, strip the ".zip" extension so the derived name matches the
    // installed plugin name (e.g. "mimi-video-0.2.0.zip" → "mimi-video-0.2.0").
    // The picker name is only a hint for the UI's same-name pre-check; core
    // still derives the authoritative name from the plugin manifest at install.
    const name = kind === "zip" ? basename(selected, extname(selected)) : basename(selected);
    return { kind, path: selected, name };
  },
);

ipcMain.handle(
  "dialog:pickPanelAppSource",
  async (
    _e,
    kind: "dir" | "zip",
  ): Promise<{ kind: "dir" | "zip"; path: string; name: string } | null> => {
    const result =
      kind === "zip"
        ? await dialog.showOpenDialog({
            title: "选择 Panel App 压缩包",
            properties: ["openFile"],
            filters: [{ name: "Zip 压缩包", extensions: ["zip"] }],
          })
        : await dialog.showOpenDialog({
            title: "选择 Panel App 文件夹",
            properties: ["openDirectory"],
          });
    if (result.canceled || result.filePaths.length === 0) return null;
    const selected = result.filePaths[0];
    const name = kind === "zip" ? basename(selected, extname(selected)) : basename(selected);
    return { kind, path: selected, name };
  },
);

ipcMain.handle("dialog:pickGitBinary", async (): Promise<string | null> => {
  const res = await dialog.showOpenDialog({
    title: "选择 git 可执行文件",
    properties: ["openFile"],
    filters:
      process.platform === "win32"
        ? [
            { name: "可执行文件", extensions: ["exe"] },
            { name: "所有文件", extensions: ["*"] },
          ]
        : [{ name: "所有文件", extensions: ["*"] }],
  });
  if (res.canceled || res.filePaths.length === 0) return null;
  return res.filePaths[0];
});

ipcMain.handle("window:new", async () => {
  await createWindow();
});

ipcMain.handle("window:isFullscreen", async (e): Promise<boolean> => {
  return BrowserWindow.fromWebContents(e.sender)?.isFullScreen() ?? false;
});

ipcMain.handle("pet:widget-visible-get", () => {
  return petWidgetShouldBeVisible && Boolean(petWidgetWindow && !petWidgetWindow.isDestroyed());
});

function broadcastPetWidgetVisibility(visible: boolean): void {
  for (const win of mainWindows) {
    if (!win.isDestroyed()) win.webContents.send("pet:widget-visibility-changed", visible);
  }
}

async function setPetWidgetVisibility(visible: boolean): Promise<void> {
  petWidgetShouldBeVisible = visible;
  if (visible) {
    await petIpcReady;
    await createPetWidgetWindow();
    if (!petWidgetShouldBeVisible) destroyPetWidgetWindow();
  } else destroyPetWidgetWindow();
  const effectiveVisible =
    petWidgetShouldBeVisible && Boolean(petWidgetWindow && !petWidgetWindow.isDestroyed());
  broadcastPetWidgetVisibility(effectiveVisible);
}

ipcMain.handle("pet:widget-visible", async (_event, visible: unknown) => {
  if (typeof visible !== "boolean") throw new Error("pet:widget-visible requires boolean");
  await setPetWidgetVisibility(visible);
  return { ok: true as const };
});

ipcMain.on("pet:widget-context-menu", (event) => {
  const win = petWidgetWindow;
  if (!win || win.isDestroyed() || event.sender !== win.webContents) return;
  const chinese = app.getLocale().toLowerCase().startsWith("zh");
  const menu = Menu.buildFromTemplate([
    {
      label: chinese ? "打开 Mimi" : "Open Mimi",
      click: () => void openPetOverviewFromWidget(),
    },
    { type: "separator" },
    {
      label: chinese ? "关闭宠物" : "Close Pet",
      click: () => void setPetWidgetVisibility(false),
    },
  ]);
  menu.popup({ window: win });
});

ipcMain.on("pet:widget-move", (event, rawPosition: unknown) => {
  const win = petWidgetWindow;
  if (!win || win.isDestroyed() || event.sender !== win.webContents) return;
  const position = sanitizePetWidgetWindowPosition(rawPosition);
  if (!position) return;
  const requestedAnchor = petAnchorForWindowOrigin(position, petWidgetSurfaceMode);
  const nextAnchor = clampPetPositionToDisplay(requestedAnchor);
  const nextOrigin = petWindowOriginForAnchor(nextAnchor, petWidgetSurfaceMode);
  win.setPosition(nextOrigin.x, nextOrigin.y, false);
});

ipcMain.handle("pet:widget-expanded", (event, expanded: unknown) => {
  if (typeof expanded !== "boolean") throw new Error("pet:widget-expanded requires boolean");
  if (petWidgetWindow && event.sender === petWidgetWindow.webContents) {
    setPetWidgetSurfaceMode(expanded ? "expanded" : "collapsed");
  }
  return { ok: true as const };
});

ipcMain.handle("pet:widget-surface", (event, mode: unknown) => {
  if (mode !== "collapsed" && mode !== "expanded") {
    throw new Error("pet:widget-surface requires collapsed or expanded");
  }
  if (petWidgetWindow && event.sender === petWidgetWindow.webContents) {
    setPetWidgetSurfaceMode(mode);
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

// Common dev-server ports (subset of Codex's list). Probed in main via real TCP
// connect (see port-probe.ts) instead of renderer no-cors fetch — no console
// noise, no opaque-response 403 false-reads. The renderer only renders the
// resulting open set.
const CANDIDATE_DEV_PORTS = [
  3000, 3001, 4000, 5000, 5173, 5174, 6006, 7000, 8000, 8080, 8888, 9000, 1420, 1313,
];
// ─── External Agent Runtimes (Codex / Claude Code) ────────────────
// The renderer picks these like any other model (`codex/gpt-5.6-sol`); these
// handlers are what makes such a key actually run something.
const MAX_EXTERNAL_RUNTIME_TEXT_CHARS = 512 * 1024;
const MAX_EXTERNAL_RUNTIME_CONTEXT_CHARS = 512 * 1024;
const MAX_EXTERNAL_RUNTIME_ATTACHMENTS = 32;
const MAX_EXTERNAL_RUNTIME_ID_CHARS = 512;

function assertDesktopSessionId(value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 128 ||
    value === "." ||
    value === ".." ||
    value.includes("..") ||
    !/^[A-Za-z0-9_.-]+$/.test(value)
  ) {
    throw new Error("invalid desktop sessionId");
  }
}

/** Which runtimes this machine can run — gates the model picker entries. */
ipcMain.handle("externalRuntime:available", () => {
  if (!externalRuntimeService?.isEnabled()) return [];
  return availableExternalRuntimes();
});

/**
 * Start (or restart) a session on an external runtime.
 *
 * The owning window comes from the SENDER, never from the payload: it decides
 * where this session's host-loopback tools are routed, so letting the renderer
 * name an arbitrary window id would let one window drive another's panels.
 */
ipcMain.handle(
  "externalRuntime:start",
  async (
    event,
    payload: {
      sessionId?: unknown;
      cwd?: unknown;
      modelKey?: unknown;
      permissionMode?: unknown;
      planMode?: unknown;
      hasGoal?: unknown;
      initialContext?: unknown;
      developerInstructions?: unknown;
    },
  ) => {
    const service = externalRuntimeService;
    if (!service) throw new Error("external runtime service is unavailable");
    const sessionId = typeof payload?.sessionId === "string" ? payload.sessionId : "";
    assertDesktopSessionId(sessionId);
    const cwd = await requireRendererProjectPath(payload?.cwd);
    const modelKey = typeof payload?.modelKey === "string" ? payload.modelKey : "";
    if (!modelKey || modelKey.length > MAX_EXTERNAL_RUNTIME_ID_CHARS) {
      throw new Error("a bounded modelKey is required");
    }
    const parsed = parseExternalRuntimeModelKey(modelKey);
    if (!parsed) throw new Error(`not an external runtime model: ${modelKey}`);
    const permissionMode =
      payload?.permissionMode === "default" ||
      payload?.permissionMode === "acceptEdits" ||
      payload?.permissionMode === "bypassPermissions" ||
      payload?.permissionMode === "dontAsk"
        ? payload.permissionMode
        : "default";

    const initialContext =
      typeof payload?.initialContext === "string" ? payload.initialContext : undefined;
    const developerInstructions =
      typeof payload?.developerInstructions === "string"
        ? payload.developerInstructions
        : undefined;
    if (
      (initialContext?.length ?? 0) > MAX_EXTERNAL_RUNTIME_CONTEXT_CHARS ||
      (developerInstructions?.length ?? 0) > MAX_EXTERNAL_RUNTIME_CONTEXT_CHARS
    ) {
      throw new Error("external runtime context is too large");
    }
    const ownerWindow = BrowserWindow.fromWebContents(event.sender);
    if (!ownerWindow || ownerWindow.isDestroyed()) {
      throw new Error("external runtime requires a live owner window");
    }
    const session = await service.start({
      kind: parsed.kind,
      sessionId,
      cwd,
      modelKey,
      permissionMode,
      planMode: payload?.planMode === true,
      hasGoal: payload?.hasGoal === true,
      ...(initialContext ? { initialContext } : {}),
      ...(developerInstructions ? { developerInstructions } : {}),
      ...(parsed.model ? { model: parsed.model } : {}),
      ownerWindow,
    });
    return {
      kind: session.kind,
      runtimeSessionId: session.runtimeSessionId ?? null,
      tools: session.listTools().map((tool) => tool.name),
    };
  },
);

ipcMain.handle(
  "externalRuntime:send",
  async (
    event,
    payload: {
      sessionId?: unknown;
      text?: unknown;
      clientMessageId?: unknown;
      attachments?: unknown;
    },
  ) => {
    const service = externalRuntimeService;
    if (!service) throw new Error("external runtime service is unavailable");
    const sessionId = typeof payload?.sessionId === "string" ? payload.sessionId : "";
    assertDesktopSessionId(sessionId);
    const text = typeof payload?.text === "string" ? payload.text : "";
    if (text.length > MAX_EXTERNAL_RUNTIME_TEXT_CHARS) {
      throw new Error("external runtime message is too large");
    }
    const clientMessageId =
      typeof payload?.clientMessageId === "string" ? payload.clientMessageId : undefined;
    if (
      clientMessageId !== undefined &&
      (!clientMessageId ||
        clientMessageId.length > MAX_EXTERNAL_RUNTIME_ID_CHARS ||
        clientMessageId.includes("\0"))
    ) {
      throw new Error("invalid external runtime clientMessageId");
    }
    if (payload?.attachments !== undefined && !Array.isArray(payload.attachments)) {
      throw new Error("external runtime attachments must be an array");
    }
    const attachmentValues = payload?.attachments ?? [];
    if (attachmentValues.length > MAX_EXTERNAL_RUNTIME_ATTACHMENTS) {
      throw new Error("too many external runtime attachments");
    }
    // The service owns the canonical cwd; use the renderer payload only for
    // turn content, never to retarget an existing runtime.
    const entryCwd = service.getCwd(sessionId, event.sender.id);
    if (!entryCwd) throw new Error("external runtime session has no authorized project");
    const attachments: ExternalRuntimeAttachment[] = await Promise.all(
      attachmentValues.map(async (value) => {
        if (!value || typeof value !== "object" || Array.isArray(value)) {
          throw new Error("invalid external runtime attachment");
        }
        const attachment = value as Record<string, unknown>;
        const path =
          typeof attachment.absPath === "string"
            ? attachment.absPath
            : typeof attachment.path === "string"
              ? attachment.path
              : "";
        const authorizedPath = await requireRendererProjectEntryPath(path, entryCwd);
        const detail =
          attachment.vision && typeof attachment.vision === "object"
            ? (attachment.vision as { detail?: unknown }).detail
            : undefined;
        if (
          attachment.mime !== undefined &&
          (typeof attachment.mime !== "string" || attachment.mime.length > 256)
        ) {
          throw new Error("invalid external runtime attachment MIME");
        }
        return {
          path: authorizedPath,
          ...(attachment.kind === "image" ||
          attachment.kind === "file" ||
          attachment.kind === "directory"
            ? { kind: attachment.kind }
            : {}),
          ...(typeof attachment.mime === "string" ? { mime: attachment.mime } : {}),
          ...(detail === "low" || detail === "standard" || detail === "high" ? { detail } : {}),
        } satisfies ExternalRuntimeAttachment;
      }),
    );
    if (!text.trim() && attachments.length === 0) {
      throw new Error("external runtime message or attachment is required");
    }
    return await service.send(
      sessionId,
      {
        text,
        ...(clientMessageId ? { clientMessageId } : {}),
        ...(attachments.length > 0 ? { attachments } : {}),
      },
      event.sender.id,
    );
  },
);

ipcMain.handle("externalRuntime:interrupt", async (event, sessionId: unknown) => {
  assertDesktopSessionId(sessionId);
  await externalRuntimeService?.interrupt(sessionId, event.sender.id);
});

/** The renderer answering a prompt this session's runtime is parked on. */
ipcMain.on(
  "externalRuntime:approvalDecision",
  (event, payload: { requestId?: unknown; approved?: unknown; [key: string]: unknown }) => {
    const requestId = typeof payload?.requestId === "string" ? payload.requestId : "";
    if (!requestId) return;
    externalRuntimeApprovals?.settle(
      requestId,
      parseExternalApprovalDecision(payload),
      event.sender.id,
    );
  },
);

ipcMain.handle("externalRuntime:stop", async (event, sessionId: unknown) => {
  assertDesktopSessionId(sessionId);
  await externalRuntimeService?.stop(sessionId, event.sender.id);
});

ipcMain.handle("browser:probePorts", async (_e, ports?: unknown) => {
  const candidates =
    Array.isArray(ports) &&
    ports.length <= 64 &&
    ports.every((p) => Number.isSafeInteger(p) && (p as number) >= 1 && (p as number) <= 65_535)
      ? (ports as number[])
      : CANDIDATE_DEV_PORTS;
  return probeLocalhostPorts(candidates);
});

// A popout pinned an element anchor → forward it to the parent window's
// renderer, which dispatches the normal add-anchor flow into the composer.
ipcMain.on("browser:anchor", (e, anchor: unknown) => {
  const parentId = popoutParents.get(e.sender.id);
  if (parentId === undefined) return;
  try {
    if (Buffer.byteLength(JSON.stringify(anchor)) > 256 * 1024) return;
  } catch {
    return;
  }
  const parent = BrowserWindow.fromId(parentId);
  if (parent && !parent.isDestroyed())
    parent.webContents.send("browser:anchor-from-popout", anchor);
});

// ── Browser-anchor hub(圈选统一架构,spec 2026-06-12)─────────────────────
// The MAIN WINDOW owns anchor state (per session bucket); it pushes the active
// bucket's browser anchors here on every change. We keep one snapshot per
// parent and broadcast it only to that parent's popouts — and seed newly-opened popouts — so
// all browser surfaces echo the same annotation set (and all clear together
// when a message sends). Ops flow the other way: a popout's add/remove is
// forwarded to its parent window, which mutates state; the loop closes via the
// next sync. Full-state-down means a late-opened popout can never drift.
function broadcastBrowserAnchors(parentId: number, snapshot: unknown[]): void {
  for (const [popoutWcId, candidateParentId] of popoutParents) {
    if (candidateParentId !== parentId) continue;
    const wc = webContents.fromId(popoutWcId);
    if (wc && !wc.isDestroyed()) wc.send("browser:anchors-state", snapshot);
  }
}

ipcMain.on("browser:anchors-sync", (event, anchors: unknown) => {
  const parent = BrowserWindow.fromWebContents(event.sender);
  if (!parent || !mainWindows.has(parent) || !Array.isArray(anchors) || anchors.length > 256)
    return;
  let snapshot: unknown[];
  try {
    const encoded = JSON.stringify(anchors);
    if (Buffer.byteLength(encoded) > 1024 * 1024) return;
    snapshot = JSON.parse(encoded) as unknown[];
  } catch {
    return;
  }
  browserAnchorsByParent.set(parent.id, snapshot);
  broadcastBrowserAnchors(parent.id, snapshot);
});

// A popout asked to remove an anchor → forward to the owner (parent window).
ipcMain.on("browser:anchor-remove", (e, anchorId: unknown) => {
  const parentId = popoutParents.get(e.sender.id);
  if (parentId === undefined) return;
  if (
    typeof anchorId !== "string" ||
    !anchorId ||
    anchorId.length > 512 ||
    anchorId.includes("\0")
  ) {
    return;
  }
  const parent = BrowserWindow.fromId(parentId);
  if (parent && !parent.isDestroyed()) {
    parent.webContents.send("browser:anchor-remove-from-popout", anchorId);
  }
});

// A popout asked to update an anchor's comment → forward to the owner.
ipcMain.on("browser:anchor-update", (e, update: unknown) => {
  const parentId = popoutParents.get(e.sender.id);
  if (parentId === undefined) return;
  try {
    if (
      !update ||
      typeof update !== "object" ||
      Buffer.byteLength(JSON.stringify(update)) > 64 * 1024
    ) {
      return;
    }
  } catch {
    return;
  }
  const parent = BrowserWindow.fromId(parentId);
  if (parent && !parent.isDestroyed()) {
    parent.webContents.send("browser:anchor-update-from-popout", update);
  }
});

ipcMain.handle("git:projectStatus", async (_e, projectId: string) => {
  const { path } = await requireRendererProjectPrimary(projectId);
  return getGitStatus(path);
});

ipcMain.handle("git:projectBranches", async (_e, projectId: string) => {
  const { path } = await requireRendererProjectPrimary(projectId);
  return getGitBranches(path);
});

ipcMain.handle("git:projectSwitchBranch", async (_e, projectId: string, branch: string) => {
  if (typeof branch !== "string" || !branch || branch.length > 1_024 || branch.includes("\0")) {
    throw new Error("git:projectSwitchBranch requires a bounded branch");
  }
  const { path } = await requireRendererProjectPrimary(projectId);
  return switchGitBranch(path, branch);
});

ipcMain.handle("git:projectStashAndSwitchBranch", async (_e, projectId: string, branch: string) => {
  if (typeof branch !== "string" || !branch || branch.length > 1_024 || branch.includes("\0")) {
    throw new Error("git:projectStashAndSwitchBranch requires a bounded branch");
  }
  const { path } = await requireRendererProjectPrimary(projectId);
  return stashAndSwitchGitBranch(path, branch);
});

ipcMain.handle("review:status", async (_e, sessionId: string) => {
  assertDesktopSessionId(sessionId);
  return reviewService.getStatus(sessionId);
});

ipcMain.handle("review:diff", async (_e, sessionId: string, request: unknown) => {
  assertDesktopSessionId(sessionId);
  return reviewService.getDiff(
    sessionId,
    request as import("../shared/review.js").ReviewGitDiffRequest,
  );
});

ipcMain.handle("review:recentCommits", async (_e, sessionId: string, limit?: number) => {
  assertDesktopSessionId(sessionId);
  return reviewService.getRecentCommits(sessionId, limit);
});

interface MainGitPrefs {
  branchPrefix: string;
  autoDeleteWorktrees: boolean;
  autoDeleteWorktreesGraceMins: number;
}

let gitPrefsCache: MainGitPrefs = {
  branchPrefix: "worktree/",
  autoDeleteWorktrees: false,
  autoDeleteWorktreesGraceMins: 60 * 24 * 7,
};

ipcMain.handle("git:setPrefs", async (_e, prefs: MainGitPrefs) => {
  if (!prefs || typeof prefs !== "object") return;
  const grace = Number(prefs.autoDeleteWorktreesGraceMins);
  let branchPrefix: string;
  try {
    branchPrefix = normalizeWorktreeBranchPrefix(prefs.branchPrefix);
  } catch {
    branchPrefix = "worktree/";
  }
  gitPrefsCache = {
    branchPrefix,
    autoDeleteWorktrees: prefs.autoDeleteWorktrees === true,
    autoDeleteWorktreesGraceMins:
      Number.isSafeInteger(grace) && grace >= 1 ? Math.min(grace, 60 * 24 * 365 * 10) : 60 * 24 * 7,
  };
  dlog("main", "git.prefs.updated", { ...gitPrefsCache });
});

function broadcastWorktreeCleanupSkipped(
  root: string,
  skipped: StaleWorktreeCleanupSkipped[],
): void {
  if (skipped.length === 0) return;
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) {
      w.webContents.send("git:worktreeCleanupSkipped", { root, skipped });
    }
  }
}

/**
 * Drives the worktree-cleanup sweep across every cwd the desktop has
 * touched this session (worktree create/list/diff/switch all funnel
 * through `cwd`). Each call is fire-and-forget; failures are logged
 * and never block the renderer.
 */
async function sweepStaleWorktrees(reason: string): Promise<void> {
  if (!gitPrefsCache.autoDeleteWorktrees) return;
  if (knownGitRoots.size === 0) return;
  const grace = gitPrefsCache.autoDeleteWorktreesGraceMins;
  const branchPrefix = gitPrefsCache.branchPrefix;
  for (const root of knownGitRoots) {
    try {
      const result = await cleanupStaleWorktrees(root, grace, branchPrefix);
      if (result.removed.length > 0) {
        dlog("main", "git.worktree.cleanup", { reason, root, removed: result.removed });
      }
      if (result.skipped.length > 0) {
        dlog("main", "git.worktree.cleanup_skipped", {
          reason,
          root,
          skipped: result.skipped,
        });
        broadcastWorktreeCleanupSkipped(root, result.skipped);
      }
    } catch (e) {
      dlog("main", "git.worktree.cleanup_error", { root, error: String(e) });
    }
  }
}

ipcMain.handle("shell:openExternal", async (_e, url: string) => {
  if (typeof url !== "string" || !url || url.length > 16_384 || url.includes("\0")) {
    throw new Error("openExternal requires a bounded url");
  }
  await openExternal(url);
});

ipcMain.handle("shell:revealInFinder", async (_e, p: string, cwd?: string) => {
  if (typeof p !== "string" || !p || p.length > 32_768 || p.includes("\0")) {
    throw new Error("revealInFinder requires a bounded path");
  }
  const authorizedCwd = cwd ? await requireRendererProjectPath(cwd) : undefined;
  await revealInFinder(p, authorizedCwd);
});

ipcMain.handle("shell:openPath", async (_e, p: string, cwd?: string) => {
  if (typeof p !== "string" || !p || p.length > 32_768 || p.includes("\0")) {
    throw new Error("openPath requires a bounded path");
  }
  const authorizedCwd = cwd ? await requireRendererProjectPath(cwd) : undefined;
  return openPath(p, authorizedCwd);
});

ipcMain.handle("shell:openInEditor", async (_e, p: string, cwd?: string) => {
  if (typeof p !== "string" || !p || p.length > 32_768 || p.includes("\0")) {
    throw new Error("openInEditor requires a bounded path");
  }
  const authorizedCwd = cwd ? await requireRendererProjectPath(cwd) : undefined;
  return openInEditor(p, authorizedCwd);
});

ipcMain.handle(
  "files:undo",
  async (_e, cwd: string, paths: string[]): Promise<UndoFilesResult[]> => {
    cwd = await requireRendererProjectPath(cwd);
    if (
      !Array.isArray(paths) ||
      paths.length === 0 ||
      paths.length > 100 ||
      paths.some((path) => typeof path !== "string" || path.length > 32_768 || path.includes("\0"))
    ) {
      throw new Error("files:undo requires non-empty paths");
    }
    return undoFiles(cwd, paths);
  },
);

// Turn-level undo/redo via core FileHistory snapshots (keyed by sessionId, not
// cwd). Always operates on the latest turn internally — see file-history-service.
ipcMain.handle("files:turnUndoState", async (event, sessionId: unknown) => {
  return turnUndoState(assertRendererSessionAccess(sessionId, event.sender.id));
});
ipcMain.handle("files:undoTurn", async (event, sessionId: unknown) => {
  return undoTurn(assertRendererSessionAccess(sessionId, event.sender.id));
});
ipcMain.handle("files:redoTurn", async (event, sessionId: unknown) => {
  return redoTurn(assertRendererSessionAccess(sessionId, event.sender.id));
});

// ── Terminal (pty) — interactive shell panel ───────────────────────────────
// Output streams back to the requesting webContents via "pty:data"/"pty:exit".
ipcMain.handle(
  "pty:start",
  async (e, opts: { sessionId: string; cwd?: string; cols?: number; rows?: number }) => {
    if (!opts) {
      throw new Error("pty:start requires sessionId");
    }
    assertValidPtySessionId(opts.sessionId);
    const cwd = await requireRendererProjectPath(opts.cwd ?? resolveNoRepoCwd());
    return ptyStart(e.sender, { ...opts, cwd });
  },
);
ipcMain.handle("pty:write", (e, sessionId: string, data: string) => {
  assertValidPtySessionId(sessionId);
  if (typeof data !== "string" || data.length > 1024 * 1024) {
    throw new Error("invalid pty input");
  }
  ptyWrite(e.sender, sessionId, data);
});
ipcMain.handle("pty:resize", (e, sessionId: string, cols: number, rows: number) => {
  assertValidPtySessionId(sessionId);
  ptyResize(e.sender, sessionId, cols, rows);
});
ipcMain.handle("pty:kill", (e, sessionId: string) => {
  assertValidPtySessionId(sessionId);
  ptyKill(e.sender, sessionId);
});

// ── Filesystem reads — file-browser panel ──────────────────────────────────
ipcMain.handle("fsRoot:readDir", async (_e, projectId: string, rootId: string, dir?: string) => {
  const root = await requireRendererProjectRoot(projectId, rootId);
  return readDirectory(root.path, typeof dir === "string" && dir ? dir : root.path);
});
ipcMain.handle("fsRoot:readFile", async (_e, projectId: string, rootId: string, path: string) => {
  const root = await requireRendererProjectRoot(projectId, rootId);
  if (typeof path !== "string" || !path) throw new Error("fsRoot:readFile requires path");
  return fsReadFile(root.path, path);
});
ipcMain.handle("fsRoot:exists", async (_e, projectId: string, rootId: string, path: string) => {
  const root = await requireRendererProjectRoot(projectId, rootId).catch(() => null);
  if (!root || typeof path !== "string" || !path) return false;
  return fsFileExists(root.path, path);
});
ipcMain.handle("fsSession:readDir", async (_e, sessionId: string, rootId: string, dir?: string) => {
  assertDesktopSessionId(sessionId);
  return readSessionDirectoryForUi(sessionId, rootId, dir);
});
ipcMain.handle(
  "fsSession:readFile",
  async (_e, sessionId: string, rootId: string, path: string) => {
    assertDesktopSessionId(sessionId);
    return readSessionFileForUi(sessionId, rootId, path);
  },
);
ipcMain.handle("fsSession:exists", async (_e, sessionId: string, rootId: string, path: string) => {
  assertDesktopSessionId(sessionId);
  return sessionFileExistsForUi(sessionId, rootId, path);
});

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
  if ("git" in patch) void applyGitPathFromSettings();
  if (touchesExternalSessionVisibility(scope, patch)) await reconcileExternalAdapters?.();
  if ("disabledPanelApps" in patch || "panelAppBindings" in patch || "panelAppOverrides" in patch) {
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

const VALID_MEMORY_LEVELS = new Set<MemoryLevel>(["user", "project", "profile"]);
const VALID_MEMORY_SCOPES = new Set<MemoryScope>(["user", "dream"]);

function validateMemoryArgs(
  level: unknown,
  scope: unknown,
): { level: MemoryLevel; scope: MemoryScope } {
  if (typeof level !== "string" || !VALID_MEMORY_LEVELS.has(level as MemoryLevel)) {
    throw new Error(`memory level must be "user", "project", or "profile", got ${String(level)}`);
  }
  if (typeof scope !== "string" || !VALID_MEMORY_SCOPES.has(scope as MemoryScope)) {
    throw new Error(`memory scope must be "user" or "dream", got ${String(scope)}`);
  }
  return { level: level as MemoryLevel, scope: scope as MemoryScope };
}

ipcMain.handle(
  "memory:list",
  async (_e, level: unknown, scope: unknown, cwd?: string, profileName?: string) => {
    const v = validateMemoryArgs(level, scope);
    const authorizedCwd =
      v.level === "project"
        ? await requireRendererProjectPath(cwd)
        : typeof cwd === "string" && cwd
          ? await requireRendererProjectPath(cwd)
          : undefined;
    return listMemory(
      v.level,
      v.scope,
      authorizedCwd,
      typeof profileName === "string" ? profileName : undefined,
    );
  },
);

ipcMain.handle(
  "memory:read",
  async (_e, level: unknown, scope: unknown, name: unknown, cwd?: string, profileName?: string) => {
    const v = validateMemoryArgs(level, scope);
    if (typeof name !== "string" || !name || name.length > 512 || name.includes("\0")) {
      throw new Error("bounded memory name required");
    }
    const authorizedCwd =
      v.level === "project"
        ? await requireRendererProjectPath(cwd)
        : typeof cwd === "string" && cwd
          ? await requireRendererProjectPath(cwd)
          : undefined;
    return readMemory(
      v.level,
      v.scope,
      name,
      authorizedCwd,
      typeof profileName === "string" ? profileName : undefined,
    );
  },
);

ipcMain.handle("memory:save", async (_e, input: SaveMemoryInput) => {
  if (!input || typeof input !== "object") throw new Error("memory:save requires input");
  const v = validateMemoryArgs(input.level, input.scope);
  if (
    typeof input.name !== "string" ||
    !input.name.trim() ||
    input.name.length > 512 ||
    typeof input.description !== "string" ||
    input.description.length > 4_096 ||
    typeof input.content !== "string" ||
    input.content.length > 1024 * 1024 ||
    (input.type !== "user" &&
      input.type !== "feedback" &&
      input.type !== "project" &&
      input.type !== "reference")
  ) {
    throw new Error("invalid memory payload");
  }
  const cwd =
    v.level === "project"
      ? await requireRendererProjectPath(input.cwd)
      : typeof input.cwd === "string" && input.cwd
        ? await requireRendererProjectPath(input.cwd)
        : undefined;
  return saveMemory({ ...input, level: v.level, scope: v.scope, cwd });
});

ipcMain.handle(
  "memory:delete",
  async (_e, level: unknown, scope: unknown, name: unknown, cwd?: string, profileName?: string) => {
    const v = validateMemoryArgs(level, scope);
    if (typeof name !== "string" || !name || name.length > 512 || name.includes("\0")) {
      throw new Error("bounded memory name required");
    }
    const authorizedCwd =
      v.level === "project"
        ? await requireRendererProjectPath(cwd)
        : typeof cwd === "string" && cwd
          ? await requireRendererProjectPath(cwd)
          : undefined;
    return deleteMemory(
      v.level,
      v.scope,
      name,
      authorizedCwd,
      typeof profileName === "string" ? profileName : undefined,
    );
  },
);

// 审批门 (pending global memories)
ipcMain.handle("memory:pending:list", async () => listPendingMemory());
ipcMain.handle("memory:pending:approve", async (_e, name: unknown) => {
  if (typeof name !== "string" || !name || name.length > 512 || name.includes("\0")) {
    throw new Error("bounded memory name required");
  }
  return approvePendingMemory(name);
});
ipcMain.handle("memory:pending:demote", async (_e, name: unknown) => {
  if (typeof name !== "string" || !name || name.length > 512 || name.includes("\0")) {
    throw new Error("bounded memory name required");
  }
  return demotePendingMemory(name);
});
ipcMain.handle("memory:pending:reject", async (_e, name: unknown) => {
  if (typeof name !== "string" || !name || name.length > 512 || name.includes("\0")) {
    throw new Error("bounded memory name required");
  }
  return rejectPendingMemory(name);
});
ipcMain.handle("memory:promote", async (_e, cwd: unknown, name: unknown) => {
  const authorizedCwd = await requireRendererProjectPath(cwd);
  if (typeof name !== "string" || !name || name.length > 512 || name.includes("\0")) {
    throw new Error("bounded memory name required");
  }
  return promoteMemoryToGlobal(authorizedCwd, name);
});

ipcMain.handle("memory:dream", async (_e, level: unknown, cwd?: string) => {
  if (level !== "user" && level !== "project") {
    throw new Error(`dream level must be "user" or "project", got ${String(level)}`);
  }
  const authorizedCwd =
    level === "project"
      ? await requireRendererProjectPath(cwd)
      : typeof cwd === "string" && cwd
        ? await requireRendererProjectPath(cwd)
        : undefined;
  return runDream(level, authorizedCwd);
});

ipcMain.handle("sessions:list", async () => listSessions());
ipcMain.handle("sessions:setArchived", async (_event, id: string, archived: boolean) => {
  assertDesktopSessionId(id);
  if (typeof archived !== "boolean") throw new Error("archived must be a boolean");
  await archiveDiskSession(id, archived ? Date.now() : undefined);
  await getSessionCwdIndex().refresh(id);
});
async function deleteDesktopSession(id: string): Promise<void> {
  const ephemeralBrowserPartition = id.startsWith("qchat-") ? partitionForSession(id) : null;
  // Reap the session's background shells (if any) before dropping it —
  // explicit delete is the one tab-close path that DOES kill (core §6).
  await bridge?.closeSession(id);
  // An external runtime is a child process plus a listening port; neither is
  // owned by the worker, so closeSession above does not touch them. Without
  // this a deleted session leaves both alive for the rest of the app's life.
  await externalRuntimeService?.stop(id).catch((error) => {
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
ipcMain.handle("sessions:titles", async () => listTitles());
ipcMain.handle("sessions:rename", async (_e, id: string, title: string) => {
  assertDesktopSessionId(id);
  if (typeof title !== "string" || title.length > 1_024 || title.includes("\0")) {
    throw new Error("title must be a bounded string");
  }
  await setTitle(id, title);
});

ipcMain.handle("logs:tail", async (_e, bucket: LogBucket, lines?: number) => {
  if (bucket !== "ui-ink" && bucket !== "engine" && bucket !== "desktop") {
    throw new Error("invalid bucket");
  }
  const boundedLines =
    typeof lines === "number" && Number.isSafeInteger(lines) && lines > 0
      ? Math.min(lines, 10_000)
      : undefined;
  return tailLog(bucket, boundedLines);
});

ipcMain.handle("runs:list", async () => listRuns());
ipcMain.handle("runs:get", async (_e, runId: string) => {
  if (typeof runId !== "string") throw new Error("runId required");
  return getRun(runId);
});
ipcMain.handle("sessions:transcript", async (_e, sessionId: string) => {
  assertDesktopSessionId(sessionId);
  return getSessionTranscript(sessionId);
});
ipcMain.handle("sessions:listDisk", async (_e, opts: { limit?: number; cursor?: string }) => {
  const limit =
    typeof opts?.limit === "number" && Number.isSafeInteger(opts.limit) && opts.limit > 0
      ? Math.min(opts.limit, 200)
      : 30;
  if (
    opts?.cursor !== undefined &&
    (typeof opts.cursor !== "string" || opts.cursor.length > 512 || opts.cursor.includes("\0"))
  ) {
    throw new Error("invalid session cursor");
  }
  return listDiskSessions({
    limit,
    cursor: typeof opts?.cursor === "string" ? opts.cursor : undefined,
  });
});
ipcMain.handle("sessions:rawEvents", async (_e, sessionId: string, sinceId?: string) => {
  assertDesktopSessionId(sessionId);
  if (
    sinceId !== undefined &&
    (typeof sinceId !== "string" || sinceId.length > 512 || sinceId.includes("\0"))
  ) {
    throw new Error("invalid transcript cursor");
  }
  return getSessionEvents(sessionId, typeof sinceId === "string" ? sinceId : undefined);
});
ipcMain.handle("runs:delete", async (_e, runId: string) => {
  if (typeof runId !== "string") throw new Error("runId required");
  await deleteRunDir(runId);
});

// ─── Automation (Phase 3 UI) ─────────────────────────────────────
function assertAutomationId(value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > 128 ||
    value.includes("\0") ||
    value.includes("/") ||
    value.includes("\\")
  ) {
    throw new Error("bounded automation id required");
  }
}

function validAutomationBindingId(value: unknown): boolean {
  return (
    value === undefined ||
    value === null ||
    (typeof value === "string" && value.length > 0 && value.length <= 512 && !value.includes("\0"))
  );
}

ipcMain.handle("automation:list", async () => listAutomations());
ipcMain.handle("automation:get", async (_e, id: string) => {
  assertAutomationId(id);
  return getAutomation(id);
});
ipcMain.handle("automation:create", async (_e, input: CreateAutomationInput) => {
  if (
    !input ||
    typeof input.name !== "string" ||
    typeof input.schedule !== "string" ||
    typeof input.prompt !== "string"
  ) {
    throw new Error("name, schedule and prompt are required");
  }
  if (
    !input.name.trim() ||
    input.name.length > 512 ||
    !input.schedule.trim() ||
    input.schedule.length > 512 ||
    input.prompt.length > 1024 * 1024 ||
    (input.timezone !== undefined &&
      (typeof input.timezone !== "string" || input.timezone.length > 128)) ||
    (input.permissionLevel !== undefined &&
      input.permissionLevel !== "read-only" &&
      input.permissionLevel !== "workspace-write" &&
      input.permissionLevel !== "full") ||
    !validAutomationBindingId(input.projectId) ||
    !validAutomationBindingId(input.rootId)
  ) {
    throw new Error("invalid automation payload");
  }
  if (input.resumeSessionId !== undefined) assertDesktopSessionId(input.resumeSessionId);
  if (Object.prototype.hasOwnProperty.call(input, "authoritySessionId")) {
    throw new Error("renderer cannot submit automation Session authority");
  }
  return createAutomation(input, desktopAutomationAuthorityDeps());
});
ipcMain.handle("automation:update", async (_e, id: string, patch: UpdateAutomationInput) => {
  assertAutomationId(id);
  if (!patch || typeof patch !== "object" || Array.isArray(patch))
    throw new Error("patch required");
  if (
    (patch.name !== undefined &&
      (typeof patch.name !== "string" || !patch.name.trim() || patch.name.length > 512)) ||
    (patch.prompt !== undefined &&
      (typeof patch.prompt !== "string" || patch.prompt.length > 1024 * 1024)) ||
    (patch.schedule !== undefined &&
      (typeof patch.schedule !== "string" ||
        !patch.schedule.trim() ||
        patch.schedule.length > 512)) ||
    (patch.timezone !== undefined &&
      (typeof patch.timezone !== "string" || patch.timezone.length > 128)) ||
    (patch.permissionLevel !== undefined &&
      patch.permissionLevel !== "read-only" &&
      patch.permissionLevel !== "workspace-write" &&
      patch.permissionLevel !== "full") ||
    !validAutomationBindingId(patch.projectId) ||
    !validAutomationBindingId(patch.rootId)
  ) {
    throw new Error("invalid automation patch");
  }
  return updateAutomation(id, patch, desktopAutomationAuthorityDeps());
});
ipcMain.handle("automation:delete", async (_e, id: string) => {
  assertAutomationId(id);
  return deleteAutomation(id);
});
ipcMain.handle("automation:pause", async (_e, id: string) => {
  assertAutomationId(id);
  return pauseAutomation(id);
});
ipcMain.handle("automation:resume", async (_e, id: string) => {
  assertAutomationId(id);
  return resumeAutomation(id);
});
ipcMain.handle("automation:runNow", async (_e, id: string) => {
  assertAutomationId(id);
  return runAutomationNow(id);
});
ipcMain.handle("automation:cancelRun", async (_e, id: string) => {
  assertAutomationId(id);
  return cancelAutomationRun(id);
});

ipcMain.handle("trust:get", async (_e, p: string) => {
  if (typeof p !== "string") throw new Error("trust:get requires path");
  return getTrust(await requireRendererProjectPath(p));
});

ipcMain.handle("trust:set", async (_e, p: string, level: TrustLevel) => {
  if (typeof p !== "string") throw new Error("trust:set requires path");
  if (level !== "trusted" && level !== "untrusted") throw new Error("invalid level");
  await setTrust(await requireRendererProjectPath(p), level);
});

ipcMain.handle("trust:risks", async (_e, p: string) => {
  if (typeof p !== "string") throw new Error("trust:risks requires path");
  return summarizeProjectTrustRisks(await requireRendererProjectPath(p));
});

ipcMain.handle("recents:list", async () => loadRecents());

ipcMain.handle(
  "notify:show",
  async (_e, opts: { title: string; body?: string; subtitle?: string }) => {
    if (
      !opts ||
      typeof opts.title !== "string" ||
      !opts.title ||
      opts.title.length > 512 ||
      (opts.body !== undefined && (typeof opts.body !== "string" || opts.body.length > 4_096)) ||
      (opts.subtitle !== undefined &&
        (typeof opts.subtitle !== "string" || opts.subtitle.length > 1_024))
    ) {
      throw new Error("notify:show requires bounded text");
    }
    if (!Notification.isSupported()) return;
    new Notification(opts).show();
  },
);

ipcMain.handle("badge:set", async (_e, count: number) => {
  if (typeof count !== "number") throw new Error("badge:set requires number");
  if (process.platform === "darwin") {
    app.dock?.setBadge(count > 0 ? String(count) : "");
  } else {
    app.setBadgeCount?.(count);
  }
});

app.on("window-all-closed", () => {
  if (!ownsDesktopInstance) return;
  if (process.platform !== "darwin") app.quit();
});

let quitCleanupPromise: Promise<void> | undefined;
let quitCleanupDone = false;
app.on("before-quit", (event) => {
  if (!ownsDesktopInstance) return;
  if (quitCleanupDone) return;
  event.preventDefault();
  if (quitCleanupPromise) return;
  browserRuntime.closeAll();
  bridge?.kill();
  petStateAggregator?.stop();
  petStateAggregator = null;
  petExternalVisibilityController?.shutdown();
  petExternalVisibilityController = null;
  reconcileExternalAdapters = null;
  petDispatchService = null;
  petHostActionReceiptService = null;
  petLongTaskCoordinator?.stop();
  petLongTaskCoordinator = null;
  unsubscribePetLongTaskStream?.();
  unsubscribePetLongTaskStream = null;
  unsubscribePetReportStream?.();
  unsubscribePetReportStream = null;
  petAttentionPolicy?.stop();
  petAttentionPolicy = null;
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
  // Each external-runtime session holds a child process and a listening port,
  // and neither dies with the parent on Windows. Captured before the async
  // block so a later reassignment cannot make this a no-op.
  const externalRuntimeShutdown = externalRuntimeService?.stopAll();
  externalRuntimeService = null;
  quitCleanupPromise = (async () => {
    await Promise.allSettled([
      imGatewayService.dispose(),
      tunnelManager.stop(),
      mobileRemote.stop(),
      gatewayControlServer?.stop(),
      petWorkInboxFlush,
      petLongTaskFlush,
      externalRuntimeShutdown,
      chromeExtensionRuntimeService.stop(),
    ]);
    gatewayControlServer = undefined;
    await mobileUploads.dispose();
    quitCleanupDone = true;
    app.quit();
  })();
});

app.on("activate", () => {
  if (ownsDesktopInstance && !preferredMainWindow()) void createWindow();
});
