/**
 * Electron main entry — broker between renderer (ipcMain) and the
 * agent worker subprocess (stdio JSON-RPC). See agent-bridge.ts.
 */

import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  session,
  shell,
  systemPreferences,
  webContents,
  Notification,
  screen,
} from "electron";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { dirname, resolve, basename, extname, join } from "node:path";
import { writeFile } from "node:fs/promises";
import {
  mergePluginMcpServers,
  listPluginHooks,
  computeEffectiveDisabledLists,
  SettingsManager,
  writeSettingsSchemaFile,
  userHome,
  CredentialStore,
  type Credential,
  type CredentialScope,
  sweepStaleCredentialCookies,
  setDefaultCredentialCipher,
  // Quota — remaining CC/Codex subscription usage.
  ErrorCodes,
  registerCapability,
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
} from "@cjhyy/code-shell-core/internal";
import {
  CODING_CAPABILITY,
  checkQuota,
  countCodexSessions,
  countSessions,
  DEFAULT_DISCOVER_LIMIT,
  DEFAULT_DISCOVER_SINCE_MS,
  discoverCodexSessions,
  discoverSessions,
  normalizeWorktreeBranchPrefix,
  probeClaudeCli,
  probeCodexCli,
  readCodexRecentHistory,
  readRecentHistory,
  resolveProjectRoot,
  resolveQuotaCredentials,
  type QuotaResult,
} from "@cjhyy/code-shell-capability-coding";
import { AgentBridge, resolveNoRepoCwd } from "./agent-bridge.js";
import { PetStateAggregator } from "./pet/pet-state-aggregator.js";
import { PET_CHAT_EVENT_CHANNEL, registerPetIpc } from "./pet/pet-ipc.js";
import { PetMetadataStore } from "./pet/pet-metadata-store.js";
import { PetDispatchService } from "./pet/pet-dispatch-service.js";
import { PetWorkDelegationHost } from "./pet/pet-work-delegation-host.js";
import { PetAttentionPolicy } from "./pet/pet-attention-policy.js";
import { PetReceiptStore } from "./pet/pet-receipt-store.js";
import { SafeStorageCipher } from "./credential-cipher.js";
import { McpOAuthService, type McpOAuthLoginInput } from "./mcp-oauth-service.js";
import { migrateCredentialStore, migrateKnownCredentialStores } from "./credential-migration.js";
import { readImageDataUrl } from "./image-read-service.js";
import {
  bucketForSession,
  browserPartitionForBucket as registryPartitionForBucket,
  guestRecordForId,
  listGuestSessions,
  rememberAttachedGuest,
  registerAttachedGuestMetadata,
  registerSessionBucket,
} from "./browser-driver/active-guest.js";
import { buildDesktopAutomationRunner, makeCronRunnerWithResume } from "./automation-host.js";
import type { CronRunResult } from "@cjhyy/code-shell-core/internal";
import {
  setAutomationScheduler,
  listAutomations,
  getAutomation,
  createAutomation,
  updateAutomation,
  deleteAutomation,
  pauseAutomation,
  resumeAutomation,
  runAutomationNow,
  cancelAutomationRun,
  type CreateAutomationInput,
  type UpdateAutomationInput,
} from "./automation-service.js";
import { dlog } from "./desktop-logger.js";
import {
  ptyStart,
  ptyWrite,
  ptyResize,
  ptyKill,
  ptyKillAll,
  ptyReapDestroyed,
} from "./pty-service.js";
import {
  listCookieDomains,
  getCookiesForDomain,
  captureCookieJar,
  captureAllCookies,
  captureAllCookiesFromSessions,
  restoreCookiesToBrowser,
  sweepStaleLeases,
  BROWSER_PARTITION,
  type ElectronCookieLike,
} from "./credentials-service.js";
import { loginAndCaptureCookies } from "./credentials-login/index.js";
import {
  AccessPasscode,
  cleanupAttachments,
  cleanupSessionAttachments,
  cleanupStaleQuickChatSessions,
  CloudflaredBinary,
  CodexRoomAgent,
  deleteSession,
  listDiskSessions,
  listRecentAttachments,
  listSessions,
  markAttachmentsSent,
  MobileUploadService,
  mobileTranscriptSubscriberId,
  PendingMobileApprovals,
  RemoteHostManager,
  ResidentAgentProcess,
  RoomManager,
  stablePromptHash,
  stageFileBytes,
  stageImageBytes,
  stageImageDataUrl,
  TrustedDeviceStore,
  TunnelManager,
  type InputAttachmentMeta,
  type MobileViewerIdentity,
} from "@cjhyy/code-shell-server";
import {
  MobileRemoteOrchestrator,
  injectAndAwaitResult,
  resolveRoomPermissionMode,
  type AuthenticatedMobileClientEvent,
} from "./mobile-remote-orchestrator.js";
import {
  GatewayControlServer,
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
  getGitNumstat,
  getGitRangeChanges,
  getGitBranchBase,
  getGitBranches,
  getGitDiff,
  getGitRangeDiff,
  getGitRecentCommits,
  switchGitBranch,
  stashAndSwitchGitBranch,
  createPermanentWorktree,
  listGitWorktrees,
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
  uninstallListedSkill,
} from "./skills-service.js";
import {
  listPlugins,
  listPanelExtensions,
  listPluginPanels,
  getPluginDetail,
  uninstallPluginEntry,
  uninstallLocalPluginEntry,
  updatePluginEntry,
  checkPluginUpdateEntry,
} from "./plugins-service.js";
import {
  expectedPluginPanelPartition,
  registerPluginPanelSchemePrivileges,
  validatePluginPanelEntryUrl,
} from "./plugin-panel-protocol.js";
import { PluginPanelBridge } from "./plugin-panel-bridge.js";
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
import { activateProfile, deactivateProfile, listProfiles } from "./profiles-service.js";
import { searchFiles } from "./file-search-service.js";
import { listAgents, readAgentBody, saveAgent, deleteAgent } from "./agents-service.js";
import type { AgentDefinition } from "@cjhyy/code-shell-core";
import {
  inspectRepo,
  installFromGithub,
  type InstallFromGithubInput,
} from "./github-skill-service.js";
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
import { loadRecents, pushRecent, loadProjects, setPinned, softDelete } from "./recents-store.js";
import { loadWindowState, saveWindowState } from "./window-state-store.js";
import {
  PET_WIDGET_EXPANDED_HEIGHT,
  PET_WIDGET_EXPANDED_WIDTH,
  PET_WIDGET_WINDOW_SIZE,
  clampPetWidgetWindowPosition,
  defaultPetWidgetWindowPosition,
  loadPetWidgetWindowPosition,
  sanitizePetWidgetWindowPosition,
  savePetWidgetWindowPosition,
  shouldSkipPetWidgetTaskbar,
} from "./pet/pet-widget-window-state.js";
import {
  getTrust,
  getTrustCachedSync,
  setTrust,
  warmTrustCache,
  summarizeProjectTrustRisks,
  type TrustLevel,
} from "./trust-store.js";
import { installAppMenu, refreshAppMenu } from "./menu.js";
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
import {
  cleanupSessionWorktreeForUi,
  getSessionWorktreeDiffForUi,
  getSessionWorkspaceForUi,
  listSessionWorktreesForUi,
  releaseManySessionWorkspacesForUi,
  releaseSessionWorkspaceForUi,
  switchSessionWorkspaceForUi,
  type WorkspaceCleanupAction,
} from "./session-workspace-service.js";

// Desktop is assembled from the reusable core plus product capability packs.
registerCapability(CODING_CAPABILITY);

const __dirname = dirname(fileURLToPath(import.meta.url));

// Custom schemes must be privileged before app.ready. The request handler is
// installed later on each plugin guest's isolated session partition.
registerPluginPanelSchemePrivileges();

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
let petWidgetExpanded = false;
let petWidgetPositionSaveTimer: ReturnType<typeof setTimeout> | null = null;
let markPetIpcReady: (() => void) | null = null;
const petIpcReady = new Promise<void>((resolveReady) => {
  markPetIpcReady = resolveReady;
});
const ownsDesktopInstance = acquireDesktopInstanceLock(app);
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
const pluginPanelBridge = new PluginPanelBridge({
  isTrustedHost: (sender) =>
    [...mainWindows].some((window) => !window.isDestroyed() && window.webContents === sender),
  isWorkspaceTrusted: (cwd) => getTrustCachedSync(cwd) === "trusted",
  getAgentBridge: () => bridge,
});
pluginPanelBridge.registerIpc();
const imGatewayService = new ImGatewayService({
  emit: (event) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send("im-gateway:event", event);
    }
  },
});
registerImGatewayIpc(ipcMain, imGatewayService);
let petStateAggregator: PetStateAggregator | null = null;
let petDispatchService: PetDispatchService | null = null;
let petAttentionPolicy: PetAttentionPolicy | null = null;
let disposePetIpc: (() => void) | null = null;
let mcpOAuthService: McpOAuthService | null = null;
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

function broadcastWorkspaceChanged(payload: {
  sessionId: string;
  workspace?: unknown;
  mainRoot?: string;
}): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send("workspace:changed", payload);
  }
}

onPluginInstallJobsChanged((jobs) => {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send("plugins:installJobsChanged", jobs);
    if (!w.isDestroyed() && jobs.some((job) => job.status === "installed")) {
      w.webContents.send("plugin-panels:changed");
    }
  }
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
  onClientEvent: (event) => {
    // The remote host tags authenticated events with both the device id and a
    // per-socket viewer id. Device state/replies remain shared per phone, while
    // transcript ownership follows the exact tab that subscribed.
    void mobileOrchestrator.handleMobileClientEvent(event as AuthenticatedMobileClientEvent);
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
    gatewayControlServer?.publish({
      type: "tunnel.connected",
      title: "CodeShell 公网隧道已连接",
      text: `公网地址：${detail}`,
      button: { text: "打开 CodeShell", url: detail },
    });
  } else if (status === "disconnected") {
    gatewayControlServer?.publish({
      type: "tunnel.disconnected",
      title: "CodeShell 公网隧道已断开",
      text: "公网隧道连接已断开，请在桌面端或聊天命令中重新开启。",
    });
  } else if (status === "error") {
    gatewayControlServer?.publish({
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
  onRoomEnded: (roomId) => transcriptSubscriptions.endRoom(roomId),
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
        kind: "plugin";
        partition: string;
        resource: NonNullable<ReturnType<typeof validatePluginPanelEntryUrl>>;
      }
  > = [];
  win.webContents.on("will-attach-webview", (event, webPreferences, params) => {
    const pluginResource = validatePluginPanelEntryUrl(String(params.src ?? ""));
    if (String(params.src ?? "").startsWith("csplugin:")) {
      if (
        !pluginResource ||
        params.partition !== expectedPluginPanelPartition(pluginResource.descriptor.hostId)
      ) {
        event.preventDefault();
        return;
      }
      webPreferences.preload = resolve(__dirname, "..", "preload", "plugin-panel.cjs");
      webPreferences.nodeIntegration = false;
      webPreferences.nodeIntegrationInSubFrames = false;
      webPreferences.contextIsolation = true;
      webPreferences.sandbox = true;
      webPreferences.webSecurity = true;
      (params as Record<string, unknown>).allowpopups = false;
      pendingWebviews.push({
        kind: "plugin",
        partition: String(params.partition),
        resource: pluginResource,
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
    if (attached.kind === "plugin") {
      pluginPanelBridge.registerGuest(guest, win, attached.resource);
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
  win.on("closed", () => {
    mainWindows.delete(win);
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
      },
    );
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
    const aggregator = new PetStateAggregator({ bridge, listDiskSessions });
    petStateAggregator = aggregator;
    const petMetadata = new PetMetadataStore(
      resolve(app.getPath("userData"), "pet", "metadata.json"),
    );
    const petWorkDelegationHost = new PetWorkDelegationHost({
      bridge,
      noWorkspaceCwd: resolveNoRepoCwd(),
    });
    petDispatchService = new PetDispatchService({
      metadata: petMetadata,
      aggregator,
      worker: bridge,
      hostCwd: resolveNoRepoCwd(),
      listWorkspaces: () => mobileOrchestrator.projectList(),
      listReusableSessions: async () => {
        const noWorkspaceCwd = resolveNoRepoCwd();
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
      startWorkSession: (delegation) => petWorkDelegationHost.start(delegation),
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
      await petReceipts.load();
      attention.start();
    })();
    disposePetIpc = registerPetIpc({
      ipcMain,
      aggregator,
      dispatcher: petDispatchService,
      attention,
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

function petWidgetSurface(expanded: boolean): { width: number; height: number } {
  return expanded
    ? { width: PET_WIDGET_EXPANDED_WIDTH, height: PET_WIDGET_EXPANDED_HEIGHT }
    : { width: PET_WIDGET_WINDOW_SIZE, height: PET_WIDGET_WINDOW_SIZE };
}

function petWindowOriginForAnchor(
  anchor: { x: number; y: number },
  expanded: boolean,
): { x: number; y: number } {
  const surface = petWidgetSurface(expanded);
  return {
    x: anchor.x - (surface.width - PET_WIDGET_WINDOW_SIZE),
    y: anchor.y - (surface.height - PET_WIDGET_WINDOW_SIZE),
  };
}

function petAnchorForWindowOrigin(
  origin: { x: number; y: number },
  expanded: boolean,
): { x: number; y: number } {
  const surface = petWidgetSurface(expanded);
  return {
    x: origin.x + (surface.width - PET_WIDGET_WINDOW_SIZE),
    y: origin.y + (surface.height - PET_WIDGET_WINDOW_SIZE),
  };
}

function currentPetAnchor(win: BrowserWindow): { x: number; y: number } {
  const { x, y } = win.getBounds();
  return petAnchorForWindowOrigin({ x, y }, petWidgetExpanded);
}

function clampPetPositionToDisplay(
  position: { x: number; y: number },
  expanded = petWidgetExpanded,
): { x: number; y: number } {
  const display = screen.getDisplayNearestPoint({
    x: position.x + Math.round(PET_WIDGET_WINDOW_SIZE / 2),
    y: position.y + Math.round(PET_WIDGET_WINDOW_SIZE / 2),
  });
  return clampPetWidgetWindowPosition(position, display.workArea, petWidgetSurface(expanded));
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

async function createPetWidgetWindowNow(): Promise<BrowserWindow> {
  if (petWidgetWindow && !petWidgetWindow.isDestroyed()) return petWidgetWindow;

  const savedPosition = await loadPetWidgetWindowPosition();
  const primaryWorkArea = screen.getPrimaryDisplay().workArea;
  const anchor = savedPosition
    ? clampPetPositionToDisplay(savedPosition, false)
    : defaultPetWidgetWindowPosition(primaryWorkArea);
  const position = petWindowOriginForAnchor(anchor, false);
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
    },
  });
  petWidgetExpanded = false;
  petWidgetWindow = win;
  if (process.platform === "darwin") void app.dock?.show();
  win.setAlwaysOnTop(true, "floating");
  try {
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  } catch {
    // Some Linux window managers do not implement workspace pinning.
  }

  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (event) => event.preventDefault());
  win.webContents.on("did-fail-load", (_event, code, desc, validatedUrl) => {
    dlog("main", "pet-widget.did-fail-load", { code, desc, validatedUrl });
  });
  win.webContents.on("console-message", (_event, level, message, line, sourceId) => {
    if (level >= 2) dlog("main", "pet-widget.console", { level, message, line, sourceId });
  });
  win.webContents.once("did-finish-load", () => {
    if (!win.isDestroyed()) win.showInactive();
  });

  win.on("move", () => schedulePetWidgetPositionSave(win));
  win.on("close", () => persistPetWidgetPosition(win));
  win.on("closed", () => {
    if (petWidgetPositionSaveTimer) {
      clearTimeout(petWidgetPositionSaveTimer);
      petWidgetPositionSaveTimer = null;
    }
    if (petWidgetWindow === win) petWidgetWindow = null;
    petWidgetExpanded = false;
  });

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

function setPetWidgetExpanded(expanded: boolean): void {
  const win = petWidgetWindow;
  if (!win || win.isDestroyed() || petWidgetExpanded === expanded) return;
  const anchor = currentPetAnchor(win);
  const nextAnchor = clampPetPositionToDisplay(anchor, expanded);
  const origin = petWindowOriginForAnchor(nextAnchor, expanded);
  const surface = petWidgetSurface(expanded);
  petWidgetExpanded = expanded;
  win.setBounds({ ...origin, ...surface }, true);
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
      win.webContents.send("browser:anchors-state", browserAnchorsSnapshot);
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
    source: { kind: "im-gateway", channel: sourceChannel },
  });
  if (!result.ok) throw new Error(result.message ?? result.code);
  if (result.type !== "chat") throw new Error("Mimi Pet 返回了非聊天结果");
  await markAttachmentsSent(cwd, sessionId, attachments).catch(() => undefined);
  const worker = result.result as { text?: unknown; reason?: unknown } | undefined;
  return {
    text: typeof worker?.text === "string" ? worker.text : "",
    petSessionId: result.petSessionId,
    ...(typeof worker?.reason === "string" ? { reason: worker.reason } : {}),
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
  writeSettingsSchemaAtStartup();
  void cleanupKnownAttachments();

  gatewayControlServer = new GatewayControlServer({
    descriptorPath: join(userHome(), ".code-shell", "im-gateway", "desktop-control.json"),
    open: () => startMobileRemote({ mode: "tunnel" }),
    close: () => stopMobileRemote(),
    status: () => getMobileRemoteGatewayStatus(),
    pairingUrl: () => createMobileRemotePairingUrl(),
    petChat: (request) => dispatchGatewayPetChat(request),
  });
  await gatewayControlServer.start().catch((error) => {
    gatewayControlServer = undefined;
    dlog("main", "im_gateway.desktop_control.start_failed", { error: String(error) });
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
      bridge?.ingestExternalEvent(sessionId, event);
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
    ): Promise<CronRunResult> => {
      if (!bridge) return { text: "", reason: "no-bridge" };
      // requireExisting: if the user deleted the target conversation, the worker
      // returns SessionNotFound instead of running the prompt against a blank
      // session. We turn that into a `stop` so the scheduler auto-disables this
      // recurring job (and the host notifies the user) rather than silently
      // re-firing into nothing every tick.
      const res = await injectAndAwaitResult(bridge, "agent/run", {
        task: prompt,
        sessionId,
        requireExisting: true,
      });
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
    const automationRunner = makeCronRunnerWithResume(headlessAutomationRunner, injectResumeTurn);
    automationHandle = startAutomation({
      store: new CronStore(defaultCronStorePath()),
      runner: automationRunner,
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

ipcMain.handle("skills:list", async (_e, cwd: string, opts?: { includeDisabled?: boolean }) =>
  listSkills(cwd, { includeDisabled: opts?.includeDisabled === true }),
);
ipcMain.handle("capabilities:list", async (_e, cwd: string) => {
  if (typeof cwd !== "string") throw new Error("capabilities:list requires cwd");
  return listCapabilities(cwd);
});
ipcMain.handle(
  "capabilities:setEnabled",
  async (_e, cwd: string, id: string, on: boolean, opts?: { scope?: "user" | "project" }) => {
    if (typeof cwd !== "string") throw new Error("capabilities:setEnabled requires cwd");
    if (typeof id !== "string") throw new Error("capabilities:setEnabled requires id");
    setCapabilityEnabled(cwd, id, Boolean(on), opts);
  },
);
ipcMain.handle(
  "capabilities:setOverride",
  async (_e, cwd: string, id: string, state: "inherit" | "on" | "off") => {
    if (typeof cwd !== "string") throw new Error("capabilities:setOverride requires cwd");
    if (typeof id !== "string") throw new Error("capabilities:setOverride requires id");
    if (state !== "inherit" && state !== "on" && state !== "off")
      throw new Error("capabilities:setOverride requires state inherit|on|off");
    setCapabilityOverride(cwd, id, state);
  },
);
ipcMain.handle("profiles:list", async (_e, cwd: string) => {
  if (typeof cwd !== "string" || !cwd) throw new Error("profiles:list requires cwd");
  return listProfiles(cwd);
});
ipcMain.handle("profiles:activate", async (_e, cwd: string, name: string) => {
  if (typeof cwd !== "string" || !cwd) throw new Error("profiles:activate requires cwd");
  if (typeof name !== "string" || !name) throw new Error("profiles:activate requires name");
  activateProfile(cwd, name);
});
ipcMain.handle("profiles:deactivate", async (_e, cwd: string) => {
  if (typeof cwd !== "string" || !cwd) throw new Error("profiles:deactivate requires cwd");
  deactivateProfile(cwd);
});
ipcMain.handle("plugins:list", async (_e, cwd: string) => {
  if (typeof cwd !== "string") throw new Error("plugins:list requires cwd");
  return listPlugins(cwd);
});
ipcMain.handle("plugin-panels:list", async (_e, cwd: string, locale: string) => {
  if (typeof cwd !== "string") throw new Error("plugin-panels:list requires cwd");
  if (typeof locale !== "string") throw new Error("plugin-panels:list requires locale");
  return listPluginPanels(cwd, locale);
});
ipcMain.handle("plugin-panels:listExtensions", async (_e, cwd: string, locale: string) => {
  if (typeof cwd !== "string") throw new Error("plugin-panels:listExtensions requires cwd");
  if (typeof locale !== "string")
    throw new Error("plugin-panels:listExtensions requires locale");
  return listPanelExtensions(cwd, locale);
});

// ── Credentials (token/link store + cookie capture) ──────────────────
// cwd may be "" for no-repo contexts; project scope no-ops without a cwd.
ipcMain.handle("credentials:list", async (_e, cwd: string) => {
  await migrateCredentialStore(cwd || undefined);
  return new CredentialStore(cwd || undefined).listMasked();
});
ipcMain.handle(
  "credentials:save",
  async (_e, cwd: string, scope: CredentialScope, cred: Credential) => {
    new CredentialStore(cwd || undefined).save(scope, cred);
    bridge?.pushCredentialSnapshot(cwd || undefined);
  },
);
ipcMain.handle(
  "credentials:remove",
  async (_e, cwd: string, scope: CredentialScope, id: string) => {
    new CredentialStore(cwd || undefined).remove(scope, id);
    bridge?.pushCredentialSnapshot(cwd || undefined);
  },
);
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
    if (typeof id !== "string" || !id) throw new Error("credentials:patchMeta requires id");
    new CredentialStore(cwd || undefined).patch(scope, id, fields as never);
    bridge?.pushCredentialSnapshot(cwd || undefined);
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
  if (typeof bucket !== "string" || !bucket) return undefined;
  // MUST match PanelArea/WebviewHost's partition exactly (no trim), or
  // capture/restore would target a different partition than the panel writes.
  return registryPartitionForBucket(bucket);
}

ipcMain.on(
  "browser:register-session-bucket",
  (_e, payload: { sessionId?: unknown; bucket?: unknown; partition?: unknown }) => {
    try {
      const sessionId = typeof payload?.sessionId === "string" ? payload.sessionId : "";
      const bucket = typeof payload?.bucket === "string" ? payload.bucket : "";
      const partition = typeof payload?.partition === "string" ? payload.partition : undefined;
      if (!sessionId || !bucket) return;
      const existingBucket = bucketForSession(sessionId);
      if (!existingBucket) {
        if (!bridge?.hasKnownSession(sessionId)) {
          dlog("browser", "register_session_bucket_rejected", {
            sessionId,
            reason: "no main-owned session",
          });
          return;
        }
        registerSessionBucket(sessionId, bucket, partition);
        return;
      }
      if (existingBucket !== bucket) {
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
      if (!Number.isFinite(guestId) || !bucket || !partition) return;
      const ownerWindow = BrowserWindow.fromWebContents(e.sender);
      if (!ownerWindow) return;
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

ipcMain.handle("credentials:cookieDomains", async (_e, bucket?: string) =>
  listCookieDomains(browserPartitionForBucket(bucket)),
);
ipcMain.handle("credentials:cookiePreview", async (_e, domain: string, bucket?: string) => {
  // Preview only: just count the cookies in the partition. No lease file is
  // materialized here — the actual cookies.txt is created on demand by the
  // (deferred) UseGate when a tool call is approved.
  const cookies = await getCookiesForDomain(domain, browserPartitionForBucket(bucket));
  return { count: cookies.length };
});
// 第二期:按域拓取 cookie jar(renderer 拿去组装成 cookie 凭证存进 CredentialStore)。
ipcMain.handle("credentials:captureCookieJar", async (_e, domain: string, bucket?: string) => {
  if (typeof domain !== "string" || !domain.trim()) {
    throw new Error("credentials:captureCookieJar requires a domain");
  }
  const jar = await captureCookieJar(domain.trim(), browserPartitionForBucket(bucket));
  return { jar, count: jar.length };
});
// 第二期+:全量拓取当前 chat session 的浏览器分区所有 cookie(不按域过滤)。
ipcMain.handle("credentials:captureAllCookies", async (_e, bucket?: string) => {
  const jar = await captureAllCookies(browserPartitionForBucket(bucket));
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
  async (_e, cwd: string, id: string, bucket?: string) => {
    if (typeof id !== "string" || !id)
      throw new Error("credentials:restoreCookieToBrowser requires id");
    const partition = browserPartitionForBucket(bucket);
    if (!partition) throw new Error("credentials:restoreCookieToBrowser requires bucket");
    await migrateCredentialStore(cwd || undefined);
    const cred = new CredentialStore(cwd || undefined).resolve(id);
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
ipcMain.handle("plugins:uninstall", async (_e, pluginName: string, marketplaceName: string) => {
  const result = uninstallPluginEntry(pluginName, marketplaceName);
  pluginPanelBridge.revokeInstallKey(`${pluginName}@${marketplaceName}`);
  for (const window of mainWindows) window.webContents.send("plugin-panels:changed");
  return result;
});
ipcMain.handle("plugins:uninstallLocal", async (_e, name: string) => {
  const result = uninstallLocalPluginEntry(name);
  pluginPanelBridge.revokeInstallKey(`${name}@local`);
  for (const window of mainWindows) window.webContents.send("plugin-panels:changed");
  return result;
});
ipcMain.handle("plugins:update", async (_e, name: string) => {
  const result = await updatePluginEntry(name);
  pluginPanelBridge.revokeInstallKey(`${name}@local`);
  for (const window of mainWindows) window.webContents.send("plugin-panels:changed");
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
    if (typeof cwd !== "string" || !(audio instanceof ArrayBuffer)) {
      return { ok: false, error: "bad-request" };
    }
    const resolved = resolveTranscribeProvider(cwd, provider);
    if (!resolved) return { ok: false, error: "no-audio-provider" };
    const mime = typeof mimeType === "string" && mimeType ? mimeType : "audio/webm";
    // Pick a filename extension matching the mime so picky servers accept it.
    const ext = mime.includes("webm")
      ? "webm"
      : mime.includes("mp4") || mime.includes("m4a")
        ? "m4a"
        : mime.includes("wav")
          ? "wav"
          : "webm";
    return transcribe({
      audio: new Uint8Array(audio),
      mimeType: mime,
      filename: `audio.${ext}`,
      model: resolved.model,
      creds: resolved.creds,
      language,
      fetchImpl: fetch,
    });
  },
);
ipcMain.handle("stt:available", async (_e, cwd: string) => ({
  available: typeof cwd === "string" ? isTranscribeAvailable(cwd) : false,
}));
// What voice input will ACTUALLY use right now (configured connection vs reused
// OpenAI key vs none) — key already masked in core. Lets the connection page
// show the active/fallback config instead of looking unconfigured.
ipcMain.handle("stt:describe", async (_e, cwd: string) =>
  typeof cwd === "string" ? describeTranscribe(cwd) : { source: "none" as const },
);
// macOS gates microphone access at the OS level (TCC). Ask BEFORE getUserMedia
// so the user gets the system prompt with our NSMicrophoneUsageDescription, and
// so a previously-denied state is reported back (renderer then shows guidance).
// No-op / always-true on other platforms. Returns whether access is granted.
ipcMain.handle("stt:ensureMicAccess", async (): Promise<{ granted: boolean }> => {
  if (process.platform !== "darwin") return { granted: true };
  const status = systemPreferences.getMediaAccessStatus("microphone");
  if (status === "granted") return { granted: true };
  // "not-determined" → triggers the system prompt; "denied"/"restricted" →
  // resolves false immediately (user must change it in System Settings).
  const granted = await systemPreferences.askForMediaAccess("microphone");
  return { granted };
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
ipcMain.handle("plugins:installLocal", async (_e, input: { kind: "dir" | "zip"; path: string }) => {
  const result = await installLocalPluginForUi(input);
  if (result.ok) {
    for (const window of mainWindows) window.webContents.send("plugin-panels:changed");
  }
  return result;
});
ipcMain.handle("skills:read", async (_e, filePath: string) => readSkillBody(filePath));
ipcMain.handle("skills:checkUpdate", async (_e, filePath: string) =>
  checkSkillUpdateEntry(filePath),
);
ipcMain.handle("skills:update", async (_e, filePath: string) => updateSkillEntry(filePath));
ipcMain.handle("files:search", async (_e, cwd: string, query: string) => {
  if (typeof cwd !== "string") throw new Error("files:search requires cwd");
  const q = typeof query === "string" ? query : "";
  return searchFiles(cwd, q);
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
    return runClaimBoundAttachmentOperation(event.sender.id, payload, () =>
      stageImageDataUrl({
        cwd: payload.cwd!,
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
    return cleanupAttachments({
      cwd: payload.cwd,
      sessionId: typeof payload.sessionId === "string" ? payload.sessionId : undefined,
      now: typeof payload.now === "number" ? payload.now : undefined,
    });
  },
);
ipcMain.handle("attachments:inspect", async (_e, payload: { cwd?: string; sessionId?: string }) => {
  if (!payload || typeof payload.cwd !== "string") {
    throw new Error("attachments:inspect requires cwd");
  }
  return listRecentAttachments({
    cwd: payload.cwd,
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
    const attachments = Array.isArray(payload.attachments) ? payload.attachments : [];
    return runClaimBoundAttachmentOperation(event.sender.id, payload, async () => {
      await markAttachmentsSent(payload.cwd!, payload.sessionId!, attachments);
      return { ok: true } as const;
    });
  },
);
ipcMain.handle(
  "skills:uninstall",
  async (
    _e,
    input: { scope?: unknown; cwd?: unknown; skillName?: unknown } | string,
    source?: "user" | "project" | "plugin",
    cwd?: string,
  ) => {
    if (typeof input === "string") {
      if (source !== "user" && source !== "project" && source !== "plugin") {
        throw new Error("invalid source");
      }
      return uninstallListedSkill(input, source, typeof cwd === "string" ? cwd : undefined);
    }
    if (!input || typeof input !== "object") {
      throw new Error("skills:uninstall requires { scope, cwd, skillName }");
    }
    const scope = input.scope === "user" || input.scope === "project" ? input.scope : null;
    if (!scope) throw new Error("invalid scope");
    if (typeof input.skillName !== "string") {
      throw new Error("skills:uninstall requires skillName");
    }
    return uninstallSkill({
      scope,
      cwd: typeof input.cwd === "string" ? input.cwd : undefined,
      skillName: input.skillName,
    });
  },
);

ipcMain.handle("agents:list", async (_e, cwd: string) => {
  if (typeof cwd !== "string") throw new Error("agents:list requires cwd");
  return listAgents(cwd);
});
ipcMain.handle("agents:read", async (_e, filePath: string) => {
  if (typeof filePath !== "string") throw new Error("agents:read requires filePath");
  return readAgentBody(filePath);
});

ipcMain.handle(
  "images:readDataUrl",
  async (
    _e,
    payload: { absPath?: unknown; cwd?: unknown; sessionId?: unknown },
  ): Promise<string | null> => {
    return readImageDataUrl(typeof payload?.absPath === "string" ? payload.absPath : "", {
      cwd: typeof payload?.cwd === "string" ? payload.cwd : undefined,
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
  async (_e, def: AgentDefinition, opts?: { scope?: "user" | "project"; cwd?: string }) => {
    if (!def || typeof def !== "object") throw new Error("agents:save requires def");
    if (typeof def.name !== "string" || typeof def.description !== "string")
      throw new Error("agents:save: name and description are required");
    return saveAgent(def, opts);
  },
);
ipcMain.handle(
  "agents:delete",
  async (_e, name: string, opts?: { scope?: "user" | "project"; cwd?: string }) => {
    if (typeof name !== "string" || !name) throw new Error("agents:delete requires name");
    return deleteAgent(name, opts);
  },
);

ipcMain.handle("skills:inspectGithub", async (_e, url: string, existingNames?: unknown) => {
  if (typeof url !== "string" || !url) {
    throw new Error("skills:inspectGithub requires url");
  }
  const names = Array.isArray(existingNames)
    ? existingNames.filter((n): n is string => typeof n === "string")
    : [];
  return inspectRepo(url, names);
});

ipcMain.handle("skills:installFromGithub", async (_e, input: unknown) => {
  if (!input || typeof input !== "object") {
    throw new Error("skills:installFromGithub requires { inspection, selected, scope }");
  }
  const i = input as InstallFromGithubInput;
  if (!i.inspection || !i.selected) throw new Error("missing inspection/selected");
  if (i.scope !== "user" && i.scope !== "project") throw new Error("invalid scope");
  return installFromGithub(i);
});

ipcMain.handle(
  "skills:installLocal",
  async (_e, sourceDir: string, scope: "user" | "project", cwd?: string, name?: string) => {
    if (typeof sourceDir !== "string" || !sourceDir) {
      throw new Error("skills:installLocal requires sourceDir");
    }
    if (scope !== "user" && scope !== "project") throw new Error("invalid scope");
    return installSkillFromDirectory(sourceDir, scope, cwd, name);
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
  async (_e, rawBase: unknown, rawDisabledPlugins?: unknown, rawCwd?: unknown) => {
    const base =
      rawBase && typeof rawBase === "object" ? (rawBase as Record<string, McpServerConfig>) : {};
    const rawList = Array.isArray(rawDisabledPlugins)
      ? rawDisabledPlugins.filter((x): x is string => typeof x === "string")
      : [];
    // Fold project capabilityOverrides over the renderer's raw global list when
    // a cwd is known — the pluginDisabled flag must reflect the EFFECTIVE state
    // (能力总览 project "on" overrides global off), matching the engine's merge.
    const cwd = typeof rawCwd === "string" && rawCwd ? rawCwd : undefined;
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
  if (!passcode || passcode.length < 4) {
    throw new Error("访问口令至少需要 4 个字符");
  }
  accessPasscode.set(passcode);
  return true;
});
ipcMain.handle("mobileRemote:tunnelStatus", async () => ({
  running: tunnelManager.isRunning(),
  connected: tunnelManager.isConnected(),
}));
ipcMain.handle("mobileRemote:updateProjects", async (_e, projects: unknown) => {
  await mobileOrchestrator.updateProjects(projects);
  return true;
});
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

// ── Projects (disk recents = source of truth; renderer is a projection) ─────
ipcMain.handle("projects:list", async () => mobileOrchestrator.projectList());
ipcMain.handle("projects:resolveRoot", async (_e, path: string) => {
  const root = resolveProjectRoot(path);
  return { path: root, name: basename(root) };
});
ipcMain.handle("projects:add", async (_e, project: { path: string; name: string }) => {
  const path = resolveProjectRoot(project.path);
  await pushRecent({ path, name: project.name || basename(path), lastOpenedAt: Date.now() });
  await mobileOrchestrator.broadcastProjects();
});
ipcMain.handle("projects:remove", async (_e, projectPath: string) => {
  await softDelete(projectPath);
  await mobileOrchestrator.broadcastProjects();
});
ipcMain.handle("projects:setPinned", async (_e, projectPath: string, pinned: boolean) => {
  await setPinned(projectPath, pinned);
  await mobileOrchestrator.broadcastProjects();
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
    const permissionMode = await resolveRoomPermissionMode(input.cwd, input.permissionMode);
    const room = roomManager.createRoom({
      name: input.name,
      cwd: input.cwd,
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
ipcMain.handle("rooms:send", async (_e, roomId: string, text: string) =>
  roomManager.send(roomId, text),
);
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
  const opts = all ? {} : { limit: DEFAULT_DISCOVER_LIMIT, sinceMs: DEFAULT_DISCOVER_SINCE_MS };
  return { sessions: discoverSessions(cwd, undefined, opts), total: countSessions(cwd) };
});
ipcMain.handle("ccRoom:listCodexSessions", async (_e, cwd: string, all?: boolean) => {
  const opts = all ? {} : { limit: DEFAULT_DISCOVER_LIMIT, sinceMs: DEFAULT_DISCOVER_SINCE_MS };
  return { sessions: discoverCodexSessions(cwd, undefined, opts), total: countCodexSessions(cwd) };
});
ipcMain.handle(
  "ccRoom:openSession",
  async (
    _e,
    claudeSessionId: string,
    cwd: string,
    mode: "default" | "acceptEdits" | "bypassPermissions",
    kind?: "claude-code" | "codex",
  ) => roomManager.openForSession(claudeSessionId, cwd, mode, kind ?? "claude-code"),
);
ipcMain.handle(
  "ccRoom:openLinkedSession",
  async (_e, externalSessionId: unknown, cwd: unknown, kind: unknown) => {
    if (typeof externalSessionId !== "string" || !externalSessionId.trim()) {
      throw new Error("external session id is required");
    }
    if (typeof cwd !== "string" || !cwd.trim()) throw new Error("cwd is required");
    if (kind !== "claude-code" && kind !== "codex") {
      throw new Error("unsupported linked session kind");
    }
    return roomManager.openLinkedSession(externalSessionId, cwd, kind);
  },
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
ipcMain.handle("ccRoom:send", async (_e, roomId: string, text: string) =>
  roomManager.send(roomId, text),
);
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
ipcMain.handle("ccRoom:readHistory", async (_e, cwd: string, sessionId: string, limit: number) =>
  readRecentHistory(cwd, sessionId, limit),
);
ipcMain.handle(
  "ccRoom:readCodexHistory",
  async (_e, cwd: string, threadId: string, limit: number) =>
    readCodexRecentHistory(cwd, threadId, limit),
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

ipcMain.handle("dialog:pickDir", async (e): Promise<{ path: string; name: string } | null> => {
  const res = await dialog.showOpenDialog({
    title: "选择项目目录",
    properties: ["openDirectory", "createDirectory"],
  });
  if (res.canceled || res.filePaths.length === 0) return null;
  // Project-boundary rule: if the user picked a SUBDIRECTORY of a git repo,
  // snap to the repo root so it belongs to that one project (not a separate
  // project per subdir — e.g. picking packages/desktop in a monorepo opens the
  // repo root). Non-git folders are returned unchanged. Best-effort; falls back
  // to the picked path on any git failure. applyGitPathFromSettings first so a
  // user-configured git.path is honored by resolveGit.
  await applyGitPathFromSettings();
  const picked = res.filePaths[0];
  const path = resolveProjectRoot(picked);
  const result = { path, name: basename(path) };
  await pushRecent({ ...result, lastOpenedAt: Date.now() });
  const win = BrowserWindow.fromWebContents(e.sender);
  if (win) void refreshAppMenu(win);
  return result;
});

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

ipcMain.handle("pet:widget-visible", async (_event, visible: unknown) => {
  if (typeof visible !== "boolean") throw new Error("pet:widget-visible requires boolean");
  petWidgetShouldBeVisible = visible;
  if (visible) {
    await petIpcReady;
    await createPetWidgetWindow();
    if (!petWidgetShouldBeVisible) destroyPetWidgetWindow();
  } else destroyPetWidgetWindow();
  const effectiveVisible =
    petWidgetShouldBeVisible && Boolean(petWidgetWindow && !petWidgetWindow.isDestroyed());
  for (const win of mainWindows) {
    if (!win.isDestroyed()) win.webContents.send("pet:widget-visibility-changed", effectiveVisible);
  }
  return { ok: true as const };
});

ipcMain.on("pet:widget-move", (event, rawPosition: unknown) => {
  const win = petWidgetWindow;
  if (!win || win.isDestroyed() || event.sender !== win.webContents) return;
  const position = sanitizePetWidgetWindowPosition(rawPosition);
  if (!position) return;
  const requestedAnchor = petAnchorForWindowOrigin(position, petWidgetExpanded);
  const nextAnchor = clampPetPositionToDisplay(requestedAnchor);
  const nextOrigin = petWindowOriginForAnchor(nextAnchor, petWidgetExpanded);
  win.setPosition(nextOrigin.x, nextOrigin.y, false);
});

ipcMain.handle("pet:widget-expanded", (event, expanded: unknown) => {
  if (typeof expanded !== "boolean") throw new Error("pet:widget-expanded requires boolean");
  if (petWidgetWindow && event.sender === petWidgetWindow.webContents) {
    setPetWidgetExpanded(expanded);
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
  if (!parent) return;
  await createBrowserPopout(parent, typeof initialUrl === "string" ? initialUrl : undefined);
});

// Common dev-server ports (subset of Codex's list). Probed in main via real TCP
// connect (see port-probe.ts) instead of renderer no-cors fetch — no console
// noise, no opaque-response 403 false-reads. The renderer only renders the
// resulting open set.
const CANDIDATE_DEV_PORTS = [
  3000, 3001, 4000, 5000, 5173, 5174, 6006, 7000, 8000, 8080, 8888, 9000, 1420, 1313,
];
ipcMain.handle("browser:probePorts", async (_e, ports?: unknown) => {
  const candidates =
    Array.isArray(ports) && ports.every((p) => typeof p === "number")
      ? (ports as number[])
      : CANDIDATE_DEV_PORTS;
  return probeLocalhostPorts(candidates);
});

// A popout pinned an element anchor → forward it to the parent window's
// renderer, which dispatches the normal add-anchor flow into the composer.
ipcMain.on("browser:anchor", (e, anchor: unknown) => {
  const parentId = popoutParents.get(e.sender.id);
  if (parentId === undefined) return;
  const parent = BrowserWindow.fromId(parentId);
  if (parent && !parent.isDestroyed())
    parent.webContents.send("browser:anchor-from-popout", anchor);
});

// ── Browser-anchor hub(圈选统一架构,spec 2026-06-12)─────────────────────
// The MAIN WINDOW owns anchor state (per session bucket); it pushes the active
// bucket's browser anchors here on every change. We keep the latest snapshot
// and broadcast it to every popout window — and seed newly-opened popouts — so
// all browser surfaces echo the same annotation set (and all clear together
// when a message sends). Ops flow the other way: a popout's add/remove is
// forwarded to its parent window, which mutates state; the loop closes via the
// next sync. Full-state-down means a late-opened popout can never drift.
let browserAnchorsSnapshot: unknown[] = [];

function broadcastBrowserAnchors(): void {
  for (const popoutWcId of popoutParents.keys()) {
    const wc = webContents.fromId(popoutWcId);
    if (wc && !wc.isDestroyed()) wc.send("browser:anchors-state", browserAnchorsSnapshot);
  }
}

ipcMain.on("browser:anchors-sync", (_e, anchors: unknown) => {
  browserAnchorsSnapshot = Array.isArray(anchors) ? anchors : [];
  broadcastBrowserAnchors();
});

// A popout asked to remove an anchor → forward to the owner (parent window).
ipcMain.on("browser:anchor-remove", (e, anchorId: unknown) => {
  const parentId = popoutParents.get(e.sender.id);
  if (parentId === undefined) return;
  const parent = BrowserWindow.fromId(parentId);
  if (parent && !parent.isDestroyed()) {
    parent.webContents.send("browser:anchor-remove-from-popout", anchorId);
  }
});

// A popout asked to update an anchor's comment → forward to the owner.
ipcMain.on("browser:anchor-update", (e, update: unknown) => {
  const parentId = popoutParents.get(e.sender.id);
  if (parentId === undefined) return;
  const parent = BrowserWindow.fromId(parentId);
  if (parent && !parent.isDestroyed()) {
    parent.webContents.send("browser:anchor-update-from-popout", update);
  }
});

ipcMain.handle("git:status", async (_e, cwd: string) => {
  if (typeof cwd !== "string" || !cwd) throw new Error("git:status requires cwd");
  return getGitStatus(cwd);
});

ipcMain.handle("git:numstat", async (_e, cwd: string) => {
  if (typeof cwd !== "string" || !cwd) throw new Error("git:numstat requires cwd");
  return getGitNumstat(cwd);
});

ipcMain.handle("git:rangeChanges", async (_e, cwd: string, range: string) => {
  if (typeof cwd !== "string" || !cwd) throw new Error("git:rangeChanges requires cwd");
  if (typeof range !== "string" || !range) throw new Error("git:rangeChanges requires range");
  return getGitRangeChanges(cwd, range);
});

ipcMain.handle("git:branchBase", async (_e, cwd: string) => {
  if (typeof cwd !== "string" || !cwd) throw new Error("git:branchBase requires cwd");
  return getGitBranchBase(cwd);
});

ipcMain.handle("git:branches", async (_e, cwd: string) => {
  if (typeof cwd !== "string" || !cwd) throw new Error("git:branches requires cwd");
  return getGitBranches(cwd);
});

ipcMain.handle("git:switchBranch", async (_e, cwd: string, branch: string) => {
  if (typeof cwd !== "string" || !cwd) throw new Error("git:switchBranch requires cwd");
  if (typeof branch !== "string" || !branch) throw new Error("git:switchBranch requires branch");
  return switchGitBranch(cwd, branch);
});

ipcMain.handle("git:stashAndSwitchBranch", async (_e, cwd: string, branch: string) => {
  if (typeof cwd !== "string" || !cwd) throw new Error("git:stashAndSwitchBranch requires cwd");
  if (typeof branch !== "string" || !branch)
    throw new Error("git:stashAndSwitchBranch requires branch");
  return stashAndSwitchGitBranch(cwd, branch);
});

ipcMain.handle(
  "git:createWorktree",
  async (_e, cwd: string, name: string, branchPrefix?: string) => {
    if (typeof cwd !== "string" || !cwd) throw new Error("git:createWorktree requires cwd");
    if (typeof name !== "string" || !name.trim())
      throw new Error("git:createWorktree requires name");
    const prefix =
      typeof branchPrefix === "string" && branchPrefix.trim()
        ? branchPrefix
        : gitPrefsCache.branchPrefix;
    const result = await createPermanentWorktree(cwd, name, prefix);
    knownGitRoots.add(cwd);
    return result;
  },
);

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
      Number.isFinite(grace) && grace >= 1 ? Math.floor(grace) : 60 * 24 * 7,
  };
  dlog("main", "git.prefs.updated", { ...gitPrefsCache });
});

const knownGitRoots = new Set<string>();

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

ipcMain.handle("git:listWorktrees", async (_e, cwd: string) => {
  if (typeof cwd !== "string" || !cwd) throw new Error("git:listWorktrees requires cwd");
  knownGitRoots.add(cwd);
  return listGitWorktrees(cwd);
});

ipcMain.handle("workspace:current", async (_e, sessionId: string, cwd: string) => {
  if (typeof sessionId !== "string" || !sessionId) {
    throw new Error("workspace:current requires sessionId");
  }
  if (typeof cwd !== "string" || !cwd) throw new Error("workspace:current requires cwd");
  knownGitRoots.add(cwd);
  return await getSessionWorkspaceForUi(sessionId, cwd);
});

ipcMain.handle("workspace:list", async (_e, sessionId: string, cwd: string) => {
  if (typeof sessionId !== "string" || !sessionId) {
    throw new Error("workspace:list requires sessionId");
  }
  if (typeof cwd !== "string" || !cwd) throw new Error("workspace:list requires cwd");
  knownGitRoots.add(cwd);
  return await listSessionWorktreesForUi(sessionId, cwd);
});

ipcMain.handle("workspace:diff", async (_e, sessionId: string, worktreePath: string) => {
  if (typeof sessionId !== "string" || !sessionId) {
    throw new Error("workspace:diff requires sessionId");
  }
  if (typeof worktreePath !== "string" || !worktreePath) {
    throw new Error("workspace:diff requires worktreePath");
  }
  knownGitRoots.add(worktreePath);
  return await getSessionWorktreeDiffForUi(sessionId, worktreePath);
});

ipcMain.handle("workspace:switch", async (_e, sessionId: string, cwd: string, target: string) => {
  if (typeof sessionId !== "string" || !sessionId) {
    throw new Error("workspace:switch requires sessionId");
  }
  if (typeof cwd !== "string" || !cwd) throw new Error("workspace:switch requires cwd");
  if (typeof target !== "string" || !target.trim()) {
    throw new Error("workspace:switch requires target");
  }
  knownGitRoots.add(cwd);
  const currentBridge = bridge;
  const list = await switchSessionWorkspaceForUi(sessionId, cwd, target, {
    setLiveWorkspace:
      currentBridge?.hasLiveWorker() && currentBridge.hasKnownSession(sessionId)
        ? (id, workspace) => currentBridge.setWorkspace(id, workspace)
        : undefined,
  });
  broadcastWorkspaceChanged({ sessionId, workspace: list.current, mainRoot: list.mainRoot });
  return list;
});

ipcMain.handle("workspace:release", async (_e, sessionId: string) => {
  if (typeof sessionId !== "string" || !sessionId) {
    throw new Error("workspace:release requires sessionId");
  }
  const currentBridge = bridge;
  const released = await releaseSessionWorkspaceForUi(sessionId, {
    releaseLiveWorkspace:
      currentBridge && currentBridge.hasKnownSession(sessionId)
        ? (id) => currentBridge.releaseWorkspace(id)
        : undefined,
  });
  if (released.status === "released") {
    broadcastWorkspaceChanged({ sessionId, workspace: released.workspace });
  }
  return released;
});

ipcMain.handle("workspace:releaseMany", async (_e, sessionIds: string[]) => {
  if (!Array.isArray(sessionIds)) {
    throw new Error("workspace:releaseMany requires sessionIds");
  }
  const ids = sessionIds.filter((id) => typeof id === "string" && id.length > 0);
  const currentBridge = bridge;
  const released = await releaseManySessionWorkspacesForUi(ids, {
    releaseLiveWorkspace: currentBridge
      ? async (id) => {
          if (!currentBridge.hasKnownSession(id)) return;
          await currentBridge.releaseWorkspace(id);
        }
      : undefined,
  });
  for (const item of released) {
    if (item.status === "released") {
      broadcastWorkspaceChanged({ sessionId: item.sessionId, workspace: item.workspace });
    }
  }
  return released;
});

ipcMain.handle(
  "workspace:cleanup",
  async (
    _e,
    sessionId: string,
    cwd: string,
    worktreePath: string,
    action: WorkspaceCleanupAction,
  ) => {
    if (typeof sessionId !== "string" || !sessionId) {
      throw new Error("workspace:cleanup requires sessionId");
    }
    if (typeof cwd !== "string" || !cwd) throw new Error("workspace:cleanup requires cwd");
    if (typeof worktreePath !== "string" || !worktreePath) {
      throw new Error("workspace:cleanup requires worktreePath");
    }
    if (action !== "detach" && action !== "discard") {
      throw new Error("workspace:cleanup requires action detach or discard");
    }
    knownGitRoots.add(cwd);
    const currentBridge = bridge;
    const list = await cleanupSessionWorktreeForUi(sessionId, cwd, worktreePath, action, {
      setLiveWorkspace:
        currentBridge?.hasLiveWorker() && currentBridge.hasKnownSession(sessionId)
          ? (id, workspace) => currentBridge.setWorkspace(id, workspace)
          : undefined,
    });
    broadcastWorkspaceChanged({ sessionId, workspace: list.current, mainRoot: list.mainRoot });
    return list;
  },
);

ipcMain.handle(
  "git:diff",
  async (_e, cwd: string, file?: string, mode?: "unstaged" | "staged" | "all") => {
    if (typeof cwd !== "string" || !cwd) throw new Error("git:diff requires cwd");
    return getGitDiff(cwd, file, mode);
  },
);

ipcMain.handle("git:recentCommits", async (_e, cwd: string, limit?: number) => {
  if (typeof cwd !== "string" || !cwd) return [];
  return getGitRecentCommits(cwd, typeof limit === "number" ? limit : undefined);
});

ipcMain.handle("git:rangeDiff", async (_e, cwd: string, range: string, file?: string) => {
  if (typeof cwd !== "string" || !cwd) throw new Error("git:rangeDiff requires cwd");
  return getGitRangeDiff(cwd, range, file);
});

ipcMain.handle("shell:openExternal", async (_e, url: string) => {
  if (typeof url !== "string") throw new Error("openExternal requires url");
  await openExternal(url);
});

ipcMain.handle("shell:revealInFinder", async (_e, p: string, cwd?: string) => {
  if (typeof p !== "string") throw new Error("revealInFinder requires path");
  await revealInFinder(p, typeof cwd === "string" ? cwd : undefined);
});

ipcMain.handle("shell:openPath", async (_e, p: string, cwd?: string) => {
  if (typeof p !== "string" || !p) throw new Error("openPath requires path");
  return openPath(p, typeof cwd === "string" ? cwd : undefined);
});

ipcMain.handle("shell:openInEditor", async (_e, p: string, cwd?: string) => {
  if (typeof p !== "string" || !p) throw new Error("openInEditor requires path");
  return openInEditor(p, typeof cwd === "string" ? cwd : undefined);
});

ipcMain.handle(
  "files:undo",
  async (_e, cwd: string, paths: string[]): Promise<UndoFilesResult[]> => {
    if (typeof cwd !== "string" || !cwd) throw new Error("files:undo requires cwd");
    if (!Array.isArray(paths) || paths.length === 0) {
      throw new Error("files:undo requires non-empty paths");
    }
    return undoFiles(cwd, paths);
  },
);

// Turn-level undo/redo via core FileHistory snapshots (keyed by sessionId, not
// cwd). Always operates on the latest turn internally — see file-history-service.
ipcMain.handle("files:turnUndoState", async (_e, sessionId: string) => {
  if (typeof sessionId !== "string" || !sessionId) {
    return { undoable: false, redoable: false, fileCount: 0 };
  }
  return turnUndoState(sessionId);
});
ipcMain.handle("files:undoTurn", async (_e, sessionId: string) => {
  if (typeof sessionId !== "string" || !sessionId) {
    throw new Error("files:undoTurn requires sessionId");
  }
  return undoTurn(sessionId);
});
ipcMain.handle("files:redoTurn", async (_e, sessionId: string) => {
  if (typeof sessionId !== "string" || !sessionId) {
    throw new Error("files:redoTurn requires sessionId");
  }
  return redoTurn(sessionId);
});

// ── Terminal (pty) — interactive shell panel ───────────────────────────────
// Output streams back to the requesting webContents via "pty:data"/"pty:exit".
ipcMain.handle(
  "pty:start",
  (e, opts: { sessionId: string; cwd?: string; cols?: number; rows?: number }) => {
    if (!opts || typeof opts.sessionId !== "string" || !opts.sessionId) {
      throw new Error("pty:start requires sessionId");
    }
    return ptyStart(e.sender, opts);
  },
);
ipcMain.handle("pty:write", (e, sessionId: string, data: string) => {
  ptyWrite(e.sender, sessionId, data);
});
ipcMain.handle("pty:resize", (e, sessionId: string, cols: number, rows: number) => {
  ptyResize(e.sender, sessionId, cols, rows);
});
ipcMain.handle("pty:kill", (e, sessionId: string) => {
  ptyKill(e.sender, sessionId);
});

// ── Filesystem reads — file-browser panel ──────────────────────────────────
ipcMain.handle("fs:readDir", async (_e, root: string, dir: string) => {
  if (typeof root !== "string" || !root) throw new Error("fs:readDir requires root");
  return readDirectory(root, typeof dir === "string" && dir ? dir : root);
});
ipcMain.handle("fs:readFile", async (_e, root: string, path: string) => {
  if (typeof root !== "string" || !root) throw new Error("fs:readFile requires root");
  if (typeof path !== "string" || !path) throw new Error("fs:readFile requires path");
  return fsReadFile(root, path);
});
ipcMain.handle("fs:exists", async (_e, root: string, path: string) => {
  if (typeof root !== "string" || !root) return false;
  if (typeof path !== "string" || !path) return false;
  return fsFileExists(root, path);
});

// Authoritative no-repo conversation cwd (~/.code-shell/no-repo). The renderer
// is a thin client and must NOT recompute homedir() itself; it asks main so the
// path it writes capabilityOverrides to is byte-identical to the worker cwd.
ipcMain.handle("no-repo:cwd", async () => resolveNoRepoCwd());

ipcMain.handle("settings:get", async (_e, scope: SettingsScope, projectPath?: string) => {
  if (scope !== "user" && scope !== "project") throw new Error("invalid scope");
  return readSettings(scope, projectPath);
});

ipcMain.handle(
  "settings:set",
  async (_e, scope: SettingsScope, patch: Record<string, unknown>, projectPath?: string) => {
    if (scope !== "user" && scope !== "project") throw new Error("invalid scope");
    if (!patch || typeof patch !== "object") throw new Error("patch must be object");
    await writeSettings(scope, patch, projectPath);
    // git.path may have changed — re-apply to core's git resolver immediately.
    if ("git" in patch) void applyGitPathFromSettings();
    if ("disabledPlugins" in patch || "capabilityOverrides" in patch) {
      for (const window of mainWindows) window.webContents.send("plugin-panels:changed");
    }
  },
);

const VALID_MEMORY_LEVELS = new Set<MemoryLevel>(["user", "project"]);
const VALID_MEMORY_SCOPES = new Set<MemoryScope>(["user", "dream"]);

function validateMemoryArgs(
  level: unknown,
  scope: unknown,
): { level: MemoryLevel; scope: MemoryScope } {
  if (typeof level !== "string" || !VALID_MEMORY_LEVELS.has(level as MemoryLevel)) {
    throw new Error(`memory level must be "user" or "project", got ${String(level)}`);
  }
  if (typeof scope !== "string" || !VALID_MEMORY_SCOPES.has(scope as MemoryScope)) {
    throw new Error(`memory scope must be "user" or "dream", got ${String(scope)}`);
  }
  return { level: level as MemoryLevel, scope: scope as MemoryScope };
}

ipcMain.handle("memory:list", async (_e, level: unknown, scope: unknown, cwd?: string) => {
  const v = validateMemoryArgs(level, scope);
  return listMemory(v.level, v.scope, typeof cwd === "string" ? cwd : undefined);
});

ipcMain.handle(
  "memory:read",
  async (_e, level: unknown, scope: unknown, name: unknown, cwd?: string) => {
    const v = validateMemoryArgs(level, scope);
    if (typeof name !== "string" || !name) throw new Error("memory name required");
    return readMemory(v.level, v.scope, name, typeof cwd === "string" ? cwd : undefined);
  },
);

ipcMain.handle("memory:save", async (_e, input: SaveMemoryInput) => {
  if (!input || typeof input !== "object") throw new Error("memory:save requires input");
  const v = validateMemoryArgs(input.level, input.scope);
  return saveMemory({ ...input, level: v.level, scope: v.scope });
});

ipcMain.handle(
  "memory:delete",
  async (_e, level: unknown, scope: unknown, name: unknown, cwd?: string) => {
    const v = validateMemoryArgs(level, scope);
    if (typeof name !== "string" || !name) throw new Error("memory name required");
    return deleteMemory(v.level, v.scope, name, typeof cwd === "string" ? cwd : undefined);
  },
);

// 审批门 (pending global memories)
ipcMain.handle("memory:pending:list", async () => listPendingMemory());
ipcMain.handle("memory:pending:approve", async (_e, name: unknown) => {
  if (typeof name !== "string" || !name) throw new Error("memory name required");
  return approvePendingMemory(name);
});
ipcMain.handle("memory:pending:demote", async (_e, name: unknown) => {
  if (typeof name !== "string" || !name) throw new Error("memory name required");
  return demotePendingMemory(name);
});
ipcMain.handle("memory:pending:reject", async (_e, name: unknown) => {
  if (typeof name !== "string" || !name) throw new Error("memory name required");
  return rejectPendingMemory(name);
});
ipcMain.handle("memory:promote", async (_e, cwd: unknown, name: unknown) => {
  if (typeof cwd !== "string" || !cwd) throw new Error("memory promote requires cwd");
  if (typeof name !== "string" || !name) throw new Error("memory name required");
  return promoteMemoryToGlobal(cwd, name);
});

ipcMain.handle("memory:dream", async (_e, level: unknown, cwd?: string) => {
  if (level !== "user" && level !== "project") {
    throw new Error(`dream level must be "user" or "project", got ${String(level)}`);
  }
  return runDream(level, typeof cwd === "string" ? cwd : undefined);
});

ipcMain.handle("sessions:list", async () => listSessions());
async function deleteDesktopSession(id: string): Promise<void> {
  // Reap the session's background shells (if any) before dropping it —
  // explicit delete is the one tab-close path that DOES kill (core §6).
  await bridge?.closeSession(id);
  await deleteSession(id);
  await cleanupKnownAttachments(id);
  // Drop any in-memory snapshot for the deleted session so it can't be
  // replayed into a fresh tab that happens to reuse the id.
  bridge?.forgetSession(id);
  pendingMobileApprovals.forgetSession(id);
}

ipcMain.handle("sessions:delete", async (_e, id: string) => {
  if (typeof id !== "string") throw new Error("session id required");
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
  if (typeof sessionId !== "string") throw new Error("sessionId required");
  return (
    bridge?.getSnapshot(sessionId, typeof sinceSeq === "number" ? sinceSeq : 0) ?? {
      events: [],
      nextSeq: 1,
      topLevelRunning: false,
    }
  );
});
ipcMain.handle("sessions:titles", async () => listTitles());
ipcMain.handle("sessions:rename", async (_e, id: string, title: string) => {
  if (typeof id !== "string") throw new Error("session id required");
  if (typeof title !== "string") throw new Error("title must be string");
  await setTitle(id, title);
});

ipcMain.handle("logs:tail", async (_e, bucket: LogBucket, lines?: number) => {
  if (bucket !== "ui-ink" && bucket !== "engine" && bucket !== "desktop") {
    throw new Error("invalid bucket");
  }
  return tailLog(bucket, lines);
});

ipcMain.handle("runs:list", async () => listRuns());
ipcMain.handle("runs:get", async (_e, runId: string) => {
  if (typeof runId !== "string") throw new Error("runId required");
  return getRun(runId);
});
ipcMain.handle("sessions:transcript", async (_e, sessionId: string) => {
  if (typeof sessionId !== "string") throw new Error("sessionId required");
  return getSessionTranscript(sessionId);
});
ipcMain.handle("sessions:listDisk", async (_e, opts: { limit?: number; cursor?: string }) => {
  const limit = typeof opts?.limit === "number" && opts.limit > 0 ? Math.min(opts.limit, 200) : 30;
  return listDiskSessions({
    limit,
    cursor: typeof opts?.cursor === "string" ? opts.cursor : undefined,
  });
});
ipcMain.handle("sessions:rawEvents", async (_e, sessionId: string, sinceId?: string) => {
  if (typeof sessionId !== "string") throw new Error("sessionId required");
  return getSessionEvents(sessionId, typeof sinceId === "string" ? sinceId : undefined);
});
ipcMain.handle("runs:delete", async (_e, runId: string) => {
  if (typeof runId !== "string") throw new Error("runId required");
  await deleteRunDir(runId);
});

// ─── Automation (Phase 3 UI) ─────────────────────────────────────
ipcMain.handle("automation:list", async () => listAutomations());
ipcMain.handle("automation:get", async (_e, id: string) => {
  if (typeof id !== "string") throw new Error("id required");
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
  const normalized = input.cwd ? { ...input, cwd: resolveProjectRoot(input.cwd) } : input;
  return createAutomation(normalized);
});
ipcMain.handle("automation:update", async (_e, id: string, patch: UpdateAutomationInput) => {
  if (typeof id !== "string") throw new Error("id required");
  if (!patch || typeof patch !== "object") throw new Error("patch required");
  const normalized = patch.cwd ? { ...patch, cwd: resolveProjectRoot(patch.cwd) } : patch;
  return updateAutomation(id, normalized);
});
ipcMain.handle("automation:delete", async (_e, id: string) => {
  if (typeof id !== "string") throw new Error("id required");
  return deleteAutomation(id);
});
ipcMain.handle("automation:pause", async (_e, id: string) => {
  if (typeof id !== "string") throw new Error("id required");
  return pauseAutomation(id);
});
ipcMain.handle("automation:resume", async (_e, id: string) => {
  if (typeof id !== "string") throw new Error("id required");
  return resumeAutomation(id);
});
ipcMain.handle("automation:runNow", async (_e, id: string) => {
  if (typeof id !== "string") throw new Error("id required");
  return runAutomationNow(id);
});
ipcMain.handle("automation:cancelRun", async (_e, id: string) => {
  if (typeof id !== "string") throw new Error("id required");
  return cancelAutomationRun(id);
});

ipcMain.handle("trust:get", async (_e, p: string) => {
  if (typeof p !== "string") throw new Error("trust:get requires path");
  return getTrust(p);
});

ipcMain.handle("trust:set", async (_e, p: string, level: TrustLevel) => {
  if (typeof p !== "string") throw new Error("trust:set requires path");
  if (level !== "trusted" && level !== "untrusted") throw new Error("invalid level");
  await setTrust(p, level);
});

ipcMain.handle("trust:risks", async (_e, p: string) => {
  if (typeof p !== "string") throw new Error("trust:risks requires path");
  return summarizeProjectTrustRisks(p);
});

ipcMain.handle("recents:list", async () => loadRecents());

ipcMain.handle(
  "notify:show",
  async (_e, opts: { title: string; body?: string; subtitle?: string }) => {
    if (!opts || typeof opts.title !== "string") throw new Error("notify:show requires title");
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
  if (process.platform !== "darwin") app.quit();
});

let quitCleanupPromise: Promise<void> | undefined;
let quitCleanupDone = false;
app.on("before-quit", (event) => {
  if (quitCleanupDone) return;
  event.preventDefault();
  if (quitCleanupPromise) return;
  bridge?.kill();
  petStateAggregator?.stop();
  petStateAggregator = null;
  petDispatchService = null;
  petAttentionPolicy?.stop();
  petAttentionPolicy = null;
  disposePetIpc?.();
  disposePetIpc = null;
  automationHandle?.stop();
  automationHandle = null;
  ptyKillAll();
  transcriptSubscriptions?.closeAll();
  roomManager.closeAll();
  quitCleanupPromise = (async () => {
    await Promise.allSettled([
      imGatewayService.dispose(),
      tunnelManager.stop(),
      mobileRemote.stop(),
      gatewayControlServer?.stop(),
    ]);
    gatewayControlServer = undefined;
    await mobileUploads.dispose();
    quitCleanupDone = true;
    app.quit();
  })();
});

app.on("activate", () => {
  if (!preferredMainWindow()) void createWindow();
});
