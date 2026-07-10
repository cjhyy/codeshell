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
} from "electron";
import { fileURLToPath } from "node:url";
import { dirname, resolve, basename, extname, join } from "node:path";
import { writeFile } from "node:fs/promises";
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
  mergePluginMcpServers,
  listPluginHooks,
  computeEffectiveDisabledLists,
  SettingsManager,
  writeSettingsSchemaFile,
  userHome,
  type AutomationHandle,
  resolveExternalAgentConfig,
  getMergedCatalog,
  saveCatalogEntry,
  deleteUserCatalogEntry,
  userCatalogPath,
  catalogEntryOrigins,
  setGitPathOverride,
  isGitAvailable,
  resolveGitPath,
  resolveProjectRoot,
  CredentialStore,
  type Credential,
  type CredentialScope,
  sweepStaleCredentialCookies,
  // CC orchestrator (external claude-cli rooms).
  probeClaudeCli,
  probeCodexCli,
  discoverSessions,
  discoverCodexSessions,
  countSessions,
  countCodexSessions,
  DEFAULT_DISCOVER_LIMIT,
  DEFAULT_DISCOVER_SINCE_MS,
  readRecentHistory,
  readCodexRecentHistory,
  // Speech-to-text (voice input / 听写).
  transcribe,
  resolveTranscribeProvider,
  isTranscribeAvailable,
  describeTranscribe,
  setDefaultCredentialCipher,
  // Quota — remaining CC/Codex subscription usage.
  checkQuota,
  resolveQuotaCredentials,
  type QuotaResult,
  ErrorCodes,
  normalizeWorktreeBranchPrefix,
} from "@cjhyy/code-shell-core";
import { AgentBridge, resolveNoRepoCwd } from "./agent-bridge.js";
import { stablePromptHash } from "./client-message-id.js";
import { SafeStorageCipher } from "./credential-cipher.js";
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
import type { CronRunResult } from "@cjhyy/code-shell-core";
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
import { RemoteHostManager } from "./mobile-remote/remote-host-manager.js";
import {
  mobileTranscriptSubscriberId,
  type MobileViewerIdentity,
} from "./mobile-remote/viewer-identity.js";
import { PendingMobileApprovals } from "./mobile-remote/pending-approvals.js";
import { TrustedDeviceStore } from "./mobile-remote/trusted-device-store.js";
import { CloudflaredBinary } from "./mobile-remote/cloudflared-binary.js";
import { TunnelManager } from "./mobile-remote/tunnel-manager.js";
import { AccessPasscode } from "./mobile-remote/access-passcode.js";
import type {
  MobileClientEvent,
  MobilePermissionModeSnapshotEntry,
  MobileProjectMeta,
  MobileServerEvent,
  PermissionMode,
  RoomPublic,
} from "./mobile-remote/types.js";
import { RoomManager } from "./mobile-remote/room-manager.js";
import { ResidentAgentProcess } from "./mobile-remote/resident-agent.js";
import { CodexRoomAgent } from "./mobile-remote/codex-room-agent.js";
import { ApprovalBridge } from "./cc-room/approval-bridge.js";
import { TranscriptSubscriptionManager } from "./cc-room/transcript-subscriptions.js";
import { QuickChatOwnershipRegistry } from "./quick-chat-ownership.js";
import { buildSessionHistory } from "./mobile-remote/mobile-history.js";
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
import {
  listSessions,
  deleteSession,
  getSessionTranscript,
  listDiskSessions,
} from "./sessions-service.js";
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
  getPluginDetail,
  uninstallPluginEntry,
  uninstallLocalPluginEntry,
  updatePluginEntry,
  checkPluginUpdateEntry,
} from "./plugins-service.js";
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
import { searchFiles } from "./file-search-service.js";
import {
  cleanupSessionAttachments,
  cleanupAttachments,
  listRecentAttachments,
  markAttachmentsSent,
  stageImageDataUrl,
} from "./attachment-service.js";
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
  getTrust,
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
  cleanupSessionWorktreeForUi,
  getSessionWorktreeDiffForUi,
  getSessionWorkspaceForUi,
  listSessionWorktreesForUi,
  releaseManySessionWorkspacesForUi,
  releaseSessionWorkspaceForUi,
  switchSessionWorkspaceForUi,
  type WorkspaceCleanupAction,
} from "./session-workspace-service.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Override the runtime app name. In dev (`electron .`) the default is
// "Electron"; this makes the macOS menu bar, Dock tooltip, and About
// panel show our product name even before packaging. setAppUserModelId
// makes Windows taskbar/notification grouping work correctly.
app.setName("code-shell");
if (process.platform === "win32") app.setAppUserModelId("com.cjhyy.codeshell");

dlog("main", "boot", { argv: process.argv, execPath: process.execPath, cwd: process.cwd() });

/**
 * The bridge is process-global: a single agent worker subprocess
 * services every BrowserWindow we open. Per-window state lives in
 * the renderer (transcripts, view, selection); the bridge just
 * pipes stdio. Multi-window therefore means "extra views into the
 * same worker" — not "extra concurrent agents".
 */
let bridge: AgentBridge | null = null;
let cspInstalled = false;
let automationHandle: AutomationHandle | null = null;
const quickChatOwnership = new QuickChatOwnershipRegistry();
const quickChatOwnerCleanupRegistered = new Set<number>();

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
const mobileRemote = new RemoteHostManager({
  devices: mobileDevices,
  onClientEvent: (event) => {
    // The remote host tags authenticated events with both the device id and a
    // per-socket viewer id. Device state/replies remain shared per phone, while
    // transcript ownership follows the exact tab that subscribed.
    void handleMobileClientEvent(event as AuthenticatedMobileClientEvent);
  },
});
const pendingMobileApprovals = new PendingMobileApprovals();

let mobileProjects: MobileProjectMeta[] = [];
function normalizeMobileProjects(projects: unknown): MobileProjectMeta[] {
  if (!Array.isArray(projects)) return [];
  const out: MobileProjectMeta[] = [];
  const seen = new Set<string>();
  for (const item of projects) {
    const p = item as Partial<MobileProjectMeta> | null;
    if (!p || typeof p.path !== "string" || !p.path || seen.has(p.path)) continue;
    seen.add(p.path);
    out.push({
      path: p.path,
      name: typeof p.name === "string" && p.name.trim() ? p.name : basename(p.path),
      ...(typeof p.addedAt === "number" ? { addedAt: p.addedAt } : {}),
      ...(typeof p.pinned === "boolean" ? { pinned: p.pinned } : {}),
    });
  }
  return out;
}
async function mobileProjectList(): Promise<MobileProjectMeta[]> {
  // Disk recents are the source of truth (pinned + soft-delete aware). The
  // legacy in-memory `mobileProjects` (pushed from the renderer's localStorage)
  // is only a fallback if disk is somehow empty — disk wins so a desktop
  // add/remove/pin is reflected on phones and survives restart.
  const projects = await loadProjects().catch(() => []);
  if (projects.length > 0) {
    return projects.map((r) => ({
      path: r.path,
      name: r.name,
      addedAt: r.lastOpenedAt,
      pinned: r.pinned,
    }));
  }
  return mobileProjects;
}
async function sendMobileProjectList(deviceId?: string): Promise<void> {
  const event: MobileServerEvent = {
    type: "room.projects.ok",
    projects: await mobileProjectList(),
  };
  if (deviceId) mobileRemote.sendToDevice(deviceId, event);
  else mobileRemote.broadcast(event);
}
/**
 * After a disk project change (add / remove / pin), push the fresh list to BOTH
 * transports: phones via room.projects.ok, desktop windows via projects:changed
 * (so the renderer re-projects its localStorage cache). Disk is the truth; this
 * is how a desktop edit becomes live on phones and how every window stays synced.
 */
async function broadcastProjects(): Promise<void> {
  const projects = await mobileProjectList();
  mobileRemote.broadcast({ type: "room.projects.ok", projects });
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send("projects:changed", projects);
  }
}
function broadcastMobileSession(meta: {
  sessionId: string;
  cwd: string;
  title: string;
  prompt: string;
  clientMessageId?: string;
}): void {
  const line = JSON.stringify({
    jsonrpc: "2.0",
    method: "agent/mobileSession",
    params: meta,
  });
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send("agent:msg", line);
  }
}

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
// Forward tunnel status changes to every renderer so the UI can reflect
// connected / disconnected (address invalidated) without polling.
tunnelManager.on("status", (status: string, detail?: unknown) => {
  if (status === "connected" && typeof detail === "string") {
    mobileRemote.setPublicBaseUrl(detail);
  }
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send("mobileRemote:tunnelStatus", { status, detail });
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

function roomMatchesTranscript(
  roomId: string,
  cwd: string,
  sessionId: string,
  kind: "claude-code" | "codex",
): boolean {
  const room = roomManager.getRoom(roomId);
  return Boolean(
    room && room.cwd === cwd && room.claudeSessionId === sessionId && room.kind === kind,
  );
}

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
 * A stable session id for the mobile client when it isn't following a specific
 * desktop session. The worker's multi-session path REQUIRES a non-empty
 * sessionId on agent/run (server.ts: "sessionId is required") — sending
 * undefined is exactly the "session id 没有" error. We lazily mint one and
 * reuse it so the phone's turns land in one coherent session. A phone that
 * explicitly selects a session (session.select) overrides this.
 */
/**
 * Per-device mobile state. Each connected phone/tablet drives its OWN session
 * selection, so two devices never clobber each other (a
 * shared global made device B's "select session 2" overwrite device A). Keyed
 * by trusted-device id. The agent OUTPUT stream is still broadcast to all
 * devices (each front-end filters to its bound session — so switching to
 * another session and pulling its history shows the latest), but per-device
 * REPLIES (chat.accepted / permission.mode / session.*) go only to that device.
 */
interface MobileDeviceState {
  /** Lazily-minted fallback session id for this device's fresh chats. */
  sessionId?: string;
  /** The session this device explicitly selected (overrides everything). */
  selectedSessionId?: string;
  /** The cwd bound to the selected or freshly-created mobile session. */
  selectedCwd?: string | null;
  /** Preset chosen before this device has a concrete session; promoted later. */
  permissionMode?: PermissionMode;
}
const mobileDeviceStates = new Map<string, MobileDeviceState>();
const mobileSessionCwds = new Map<string, string | null>();
const mobilePermissionModes = new Map<string, PermissionMode>();
function deviceState(deviceId: string): MobileDeviceState {
  let s = mobileDeviceStates.get(deviceId);
  if (!s) {
    s = {};
    mobileDeviceStates.set(deviceId, s);
  }
  return s;
}
function ensureMobileSessionId(st: MobileDeviceState): string {
  if (!st.sessionId) {
    st.sessionId = `mobile-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }
  return st.sessionId;
}

async function lookupDiskSessionCwd(sessionId: string): Promise<string | null | undefined> {
  const cached = mobileSessionCwds.get(sessionId);
  if (cached !== undefined) return cached;
  let cursor: string | undefined;
  for (let page = 0; page < 10; page++) {
    const res = await listDiskSessions({ limit: 100, cursor }).catch(() => ({
      sessions: [],
      nextCursor: null,
    }));
    for (const s of res.sessions) {
      mobileSessionCwds.set(s.id, s.cwd || null);
      if (s.id === sessionId || s.engineSessionId === sessionId) {
        const cwd = s.cwd || null;
        mobileSessionCwds.set(sessionId, cwd);
        return cwd;
      }
    }
    if (!res.nextCursor) break;
    cursor = res.nextCursor;
  }
  return undefined;
}

function effectiveMobileRunCwd(st: MobileDeviceState, ctxCwd?: string): string {
  if (st.selectedCwd === null) return resolveNoRepoCwd();
  return st.selectedCwd || ctxCwd || process.cwd();
}

function normalizePermissionMode(raw: unknown): PermissionMode | null {
  return raw === "default" || raw === "acceptEdits" || raw === "bypassPermissions" ? raw : null;
}

function normalizePermissionModeSnapshot(raw: unknown): MobilePermissionModeSnapshotEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: MobilePermissionModeSnapshotEntry[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const row = item as { sessionId?: unknown; mode?: unknown } | null;
    const sessionId = typeof row?.sessionId === "string" ? row.sessionId : "";
    const mode = normalizePermissionMode(row?.mode);
    if (!sessionId || !mode || seen.has(sessionId)) continue;
    seen.add(sessionId);
    out.push({ sessionId, mode });
  }
  return out;
}

function sendMobilePermissionMode(deviceId: string | undefined, sessionId: string): void {
  const event: MobileServerEvent = {
    type: "permission.mode",
    sessionId,
    mode: mobilePermissionModes.get(sessionId) ?? "default",
  };
  if (deviceId) mobileRemote.sendToDevice(deviceId, event);
  else mobileRemote.broadcast(event);
}

function sendSelectedMobilePermissionModes(): void {
  for (const [deviceId, st] of mobileDeviceStates) {
    const sessionId = st.selectedSessionId ?? st.sessionId;
    if (sessionId) sendMobilePermissionMode(deviceId, sessionId);
  }
}

function broadcastDesktopPermissionMode(params: { sessionId: string; mode: PermissionMode }): void {
  const line = JSON.stringify({
    jsonrpc: "2.0",
    method: "agent/mobilePermissionMode",
    params,
  });
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send("agent:msg", line);
  }
}

function replayPendingMobileApprovals(sessionId: string, deviceId?: string): void {
  for (const line of pendingMobileApprovals.replayLines(sessionId)) {
    if (deviceId) mobileRemote.sendRawToDevice(deviceId, line);
    else mobileRemote.broadcastRaw(line);
  }
}

function broadcastApprovalResolved(params: {
  requestId: string;
  sessionId?: string;
  approved?: boolean;
}): void {
  pendingMobileApprovals.resolve(params.requestId);
  const line = JSON.stringify({
    jsonrpc: "2.0",
    method: "agent/approvalResolved",
    params,
  });
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send("agent:msg", line);
  }
  mobileRemote.broadcast({
    type: "approval.resolved",
    approvalId: params.requestId,
    ...(params.sessionId ? { sessionId: params.sessionId } : {}),
    ...(params.approved !== undefined ? { approved: params.approved } : {}),
  });
}

/**
 * Inject a JSON-RPC request into the worker and resolve with its ACTUAL
 * response (result on success, or failure on a JSON-RPC error / timeout). The
 * worker's reply flows back through subscribeOutbound (the same lines mirrored
 * to mobile), so we correlate by request id rather than fabricating success — a
 * model.set for an invalid model or a rejected goal.extend must NOT be reported
 * to the phone as ok.
 */
// Monotonic suffix so two requests for the same method in the same millisecond
// get distinct ids (Date.now() alone collides under concurrency → reply串台).
let mobileRequestSeq = 0;
function injectAndAwaitResult(
  b: AgentBridge,
  method: string,
  params: Record<string, unknown>,
): Promise<{ ok: true; result: unknown } | { ok: false; message: string; code?: number }> {
  const id = `mobile-${method.replace(/\W+/g, "-")}-${Date.now()}-${mobileRequestSeq++}`;
  return new Promise((resolveResult) => {
    let settled = false;
    const done = (
      v: { ok: true; result: unknown } | { ok: false; message: string; code?: number },
    ): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unsub();
      resolveResult(v);
    };
    const unsub = b.subscribeOutbound((line) => {
      try {
        const m = JSON.parse(line) as {
          id?: string;
          result?: unknown;
          error?: { message?: string; code?: number };
        };
        if (m.id !== id) return;
        if (m.error)
          done({
            ok: false,
            message: m.error.message ?? "worker rejected the request",
            code: m.error.code,
          });
        else done({ ok: true, result: m.result });
      } catch {
        /* not JSON / not ours */
      }
    });
    // Fallback: if the worker never answers (dead/slow), report failure rather
    // than hanging — the phone keeps showing its prior state.
    const timer = setTimeout(() => done({ ok: false, message: "worker did not respond" }), 5000);
    b.injectWorkerMessage(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
  });
}

/**
 * Route an authenticated mobile client event into the SAME run/permission
 * path the renderer uses, via AgentBridge.injectWorkerMessage. There is no
 * second run loop: chat/approval/cancel become the identical JSON-RPC lines
 * the renderer's preload rpc() would emit, so the core permission engine,
 * goal logic, and snapshots all apply unchanged.
 */
async function handleMobileClientEvent(event: AuthenticatedMobileClientEvent): Promise<void> {
  // ── CC Room (external claude CLI sessions) — checked first so "ccRoom.*"
  // never gets misrouted by the "room." prefix check below ───────────────
  if (event.type.startsWith("ccRoom.")) {
    await handleCcRoomEvent(event);
    return;
  }
  // ── Rooms (independent of the chat worker bridge) ─────────────────────
  if (event.type.startsWith("room.")) {
    await handleRoomEvent(event);
    return;
  }
  if (!bridge) return;
  const ctx = bridge.getLastRunContext();
  // Per-device state: the remote host tags every authenticated event with the
  // device id (see onClientEvent wiring). Replies that are device-specific go
  // back to ONLY that device via sendToDevice; the agent output stream is still
  // broadcast (each front-end filters to its bound session).
  const deviceId = event.deviceId;
  const st = deviceId ? deviceState(deviceId) : {};
  const reply = (e: MobileServerEvent): void => {
    if (deviceId) mobileRemote.sendToDevice(deviceId, e);
    else mobileRemote.broadcast(e);
  };
  // session selection priority: explicit per-event → this device's selection →
  // desktop's current run → a stable minted per-device session.
  const resolveSessionId = (explicit?: string): string =>
    explicit ?? st.selectedSessionId ?? ctx.sessionId ?? ensureMobileSessionId(st);
  if (event.type === "session.select") {
    st.selectedSessionId = event.sessionId;
    const cwd = await lookupDiskSessionCwd(event.sessionId);
    if (cwd !== undefined) st.selectedCwd = cwd;
    if (deviceId) sendMobilePermissionMode(deviceId, event.sessionId);
    else {
      reply({
        type: "permission.mode",
        sessionId: event.sessionId,
        mode: mobilePermissionModes.get(event.sessionId) ?? "default",
      });
    }
    replayPendingMobileApprovals(event.sessionId, deviceId);
    return;
  }
  if (event.type === "session.create") {
    // Mint a fresh session for THIS device and make it its active selection.
    st.sessionId = `mobile-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    st.selectedSessionId = st.sessionId;
    if ("cwd" in event) {
      st.selectedCwd = event.cwd ?? null;
    } else {
      st.selectedCwd = ctx.cwd ?? process.cwd();
    }
    mobileSessionCwds.set(st.sessionId, st.selectedCwd);
    if (st.permissionMode) mobilePermissionModes.set(st.sessionId, st.permissionMode);
    reply({ type: "chat.accepted", sessionId: st.sessionId, cwd: st.selectedCwd });
    if (deviceId) sendMobilePermissionMode(deviceId, st.sessionId);
    else {
      reply({
        type: "permission.mode",
        sessionId: st.sessionId,
        mode: mobilePermissionModes.get(st.sessionId) ?? "default",
      });
    }
    return;
  }
  if (event.type === "chat.send") {
    const sessionId = resolveSessionId(event.sessionId);
    const cwd = effectiveMobileRunCwd(st, ctx.cwd);
    mobileSessionCwds.set(sessionId, st.selectedCwd ?? cwd);
    if (st.permissionMode && !mobilePermissionModes.has(sessionId)) {
      mobilePermissionModes.set(sessionId, st.permissionMode);
    }
    const permissionMode = mobilePermissionModes.get(sessionId);
    const runId = `mobile-run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    const clientMessageId = `mobile:${sessionId}:${runId}:${stablePromptHash(event.text)}`;
    broadcastMobileSession({
      sessionId,
      cwd,
      title: event.text,
      prompt: event.text,
      clientMessageId,
    });
    // Every phone chat turn is a normal CodeShell turn routed through the worker
    // run path. The device's permission-mode preset rides on the run.
    bridge.injectWorkerMessage(
      JSON.stringify({
        jsonrpc: "2.0",
        id: runId,
        method: "agent/run",
        params: {
          task: event.text,
          cwd,
          sessionId,
          clientMessageId,
          ...(permissionMode ? { permissionMode } : {}),
        },
      }),
    );
    // Tell THIS device which session its turn landed in.
    reply({ type: "chat.accepted", sessionId, cwd });
    return;
  }
  if (event.type === "approval.respond") {
    // Build the same ApprovalResult branch the renderer's preload assembles:
    // approve carries optional answer (AskUser) + remembered scope/pathScope;
    // reject carries an optional reason. Decisions still go through the core
    // permission engine — the remote host never bypasses it (design §6).
    let decision: Record<string, unknown>;
    if (event.decision === "approve") {
      const branch: Record<string, unknown> = { approved: true };
      if (event.answer !== undefined) branch.answer = event.answer;
      if (event.scope && event.scope !== "once") {
        branch.always = true;
        branch.scope = event.scope;
        if (event.pathScope && event.pathScope !== "tool") branch.pathScope = event.pathScope;
      }
      decision = branch;
    } else {
      decision = { approved: false, reason: event.reason };
    }
    const sessionId = resolveSessionId(event.sessionId);
    bridge.injectWorkerMessage(
      JSON.stringify({
        jsonrpc: "2.0",
        id: `mobile-approve-${Date.now()}`,
        method: "agent/approve",
        params: { sessionId, requestId: event.approvalId, decision },
      }),
    );
    broadcastApprovalResolved({
      requestId: event.approvalId,
      sessionId,
      approved: event.decision === "approve",
    });
    return;
  }
  if (event.type === "run.stop") {
    bridge.injectWorkerMessage(
      JSON.stringify({
        jsonrpc: "2.0",
        id: `mobile-cancel-${Date.now()}`,
        method: "agent/cancel",
        params: { sessionId: resolveSessionId(event.sessionId) },
      }),
    );
    return;
  }
  if (event.type === "session.list") {
    // Every desktop session the sidebar would show (top-level, existing cwd).
    const { sessions } = await listDiskSessions({ limit: 100 });
    for (const s of sessions) mobileSessionCwds.set(s.id, s.cwd || null);
    const activeSessionId = st.selectedSessionId ?? ctx.sessionId;
    reply({
      type: "session.list.ok",
      sessions: sessions.map((s) => ({
        id: s.id,
        title: s.title,
        cwd: s.cwd,
        updatedAt: s.updatedAt,
        origin: s.origin,
      })),
      activeSessionId,
    });
    if (activeSessionId) {
      if (deviceId) sendMobilePermissionMode(deviceId, activeSessionId);
      else {
        reply({
          type: "permission.mode",
          sessionId: activeSessionId,
          mode: mobilePermissionModes.get(activeSessionId) ?? "default",
        });
      }
    }
    return;
  }
  if (event.type === "session.history") {
    try {
      const events = await buildSessionHistory(event.sessionId);
      reply({ type: "session.history.ok", sessionId: event.sessionId, events });
    } catch (err) {
      reply({
        type: "error",
        message: `读取会话历史失败: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
    return;
  }
  if (event.type === "session.sync") {
    const snapshot = bridge.getSnapshot(
      event.sessionId,
      typeof event.sinceSeq === "number" ? event.sinceSeq : 0,
    );
    reply({
      type: "session.snapshot",
      sessionId: event.sessionId,
      entries: snapshot.events,
      nextSeq: snapshot.nextSeq,
    });
    replayPendingMobileApprovals(event.sessionId, deviceId);
    return;
  }
  if (event.type === "permission.setMode") {
    const sessionId = event.sessionId ?? st.selectedSessionId;
    if (sessionId) {
      mobilePermissionModes.set(sessionId, event.mode);
      sendSelectedMobilePermissionModes();
      broadcastDesktopPermissionMode({ sessionId, mode: event.mode });
    } else {
      // No session is bound yet; keep this as the preset for the next mobile
      // session this device creates, then promote it into the session map.
      st.permissionMode = event.mode;
      reply({ type: "permission.mode", mode: event.mode });
    }
    return;
  }
  if (event.type === "model.set") {
    // Only confirm the model AFTER the worker actually applied it; an invalid
    // model name must not be shown as the current model. Model is engine-global,
    // so a successful change broadcasts to all devices.
    const res = await injectAndAwaitResult(bridge, "agent/configure", { model: event.model });
    if (res.ok) {
      mobileRemote.broadcast({ type: "model.current", model: event.model });
    } else {
      reply({ type: "error", message: `切换模型失败:${res.message}` });
    }
    return;
  }
  if (event.type === "goal.extend") {
    const res = await injectAndAwaitResult(bridge, "agent/goalExtend", {
      sessionId: event.sessionId,
      addTurns: event.addTurns,
      addTokenBudget: event.addTokenBudget,
      addTimeBudgetMs: event.addTimeBudgetMs,
      addStopBlocks: event.addStopBlocks,
    });
    // Report the REAL outcome (ok:false carries the worker's reason).
    reply({
      type: "goal.extended",
      sessionId: event.sessionId,
      ok: res.ok,
      message: res.ok ? undefined : res.message,
    });
    return;
  }
  if (event.type === "goal.clear") {
    const res = await injectAndAwaitResult(bridge, "agent/goalClear", {
      sessionId: event.sessionId,
    });
    // The worker's result carries { ok, cleared }; surface `cleared` so the
    // phone can tell "there was a goal, now gone" from "nothing to clear".
    const cleared =
      res.ok && typeof (res.result as { cleared?: boolean } | undefined)?.cleared === "boolean"
        ? (res.result as { cleared: boolean }).cleared
        : undefined;
    reply({
      type: "goal.cleared",
      sessionId: event.sessionId,
      ok: res.ok,
      cleared,
      message: res.ok ? undefined : res.message,
    });
    return;
  }
}

function roomToPublic(room: {
  id: string;
  name: string;
  cwd: string;
  kind: "claude-code" | "codex";
  permissionMode: "default" | "acceptEdits" | "bypassPermissions";
  createdAt: number;
  lastActiveAt: number;
}): RoomPublic {
  return { ...room, open: roomManager.isOpen(room.id) };
}

/**
 * Decide a room's permission mode. A room in a TRUSTED workspace (per
 * externalAgents.claudeCode.trustedWorkspaces, the same allowlist that governs
 * /cc dangerous mode) gets bypassPermissions so the resident CC can actually
 * do work without being blocked by its own default gate. Anywhere else stays
 * "default" (CC auto-denies risky ops). An explicit mode from the phone wins,
 * EXCEPT a non-trusted cwd cannot silently get bypassPermissions — it is
 * downgraded to "default" (the high-risk gate). cwd normalized to ignore
 * trailing slashes.
 */
async function resolveRoomPermissionMode(
  cwd: string,
  explicit: "default" | "acceptEdits" | "bypassPermissions" | undefined,
): Promise<"default" | "acceptEdits" | "bypassPermissions"> {
  const userSettings = ((await readSettings("user", cwd).catch(() => null)) ?? {}) as {
    externalAgents?: Parameters<typeof resolveExternalAgentConfig>[0];
  };
  const projectSettings = ((await readSettings("project", cwd).catch(() => null)) ?? {}) as {
    externalAgents?: Parameters<typeof resolveExternalAgentConfig>[0];
  };
  const userAgents = userSettings.externalAgents ?? {};
  const projectAgents = projectSettings.externalAgents ?? {};
  const mergedAgents = {
    ...userAgents,
    ...projectAgents,
    claudeCode: {
      ...userAgents.claudeCode,
      ...projectAgents.claudeCode,
    },
  };
  const cfg = resolveExternalAgentConfig(mergedAgents).claudeCode;
  const norm = (p: string) => p.replace(/\/+$/, "");
  const trusted = cfg.trustedWorkspaces.some((p) => norm(p) === norm(cwd));
  if (explicit === "bypassPermissions") {
    return trusted ? "bypassPermissions" : "default"; // non-trusted can't silently bypass
  }
  if (explicit) return explicit;
  return trusted ? "bypassPermissions" : "default";
}

/**
 * Handle a room.* mobile event. Rooms are resident stream-json Claude Code
 * sessions; they do not go through the chat worker bridge. permissionMode for
 * a non-trusted cwd that requests bypassPermissions is downgraded to "default"
 * here (the high-risk gate is surfaced by the UI / future approval step).
 */
type AuthenticatedMobileClientEvent = MobileClientEvent & {
  deviceId?: string;
  viewerId?: string;
};

async function handleRoomEvent(event: AuthenticatedMobileClientEvent): Promise<void> {
  try {
    if (event.type === "room.list") {
      mobileRemote.broadcast({
        type: "room.list.ok",
        rooms: roomManager.listRooms().map(roomToPublic),
      });
      return;
    }
    if (event.type === "room.projects") {
      await sendMobileProjectList(event.deviceId);
      return;
    }
    if (event.type === "room.create") {
      const permissionMode = await resolveRoomPermissionMode(event.cwd, event.permissionMode);
      const room = roomManager.createRoom({
        name: event.name,
        cwd: event.cwd,
        kind: event.kind,
        permissionMode,
      });
      const opened = roomManager.open(room.id);
      mobileRemote.broadcast({
        type: "room.list.ok",
        rooms: roomManager.listRooms().map(roomToPublic),
      });
      mobileRemote.broadcast({ type: "room.opened", roomId: room.id, status: opened.status });
      return;
    }
    if (event.type === "room.open") {
      const res = roomManager.open(event.roomId);
      mobileRemote.broadcast({ type: "room.opened", roomId: event.roomId, status: res.status });
      return;
    }
    if (event.type === "room.close") {
      roomManager.close(event.roomId);
      mobileRemote.broadcast({ type: "room.closed", roomId: event.roomId });
      return;
    }
    if (event.type === "room.history") {
      const messages = roomManager.getMessages(event.roomId, event.sinceSeq ?? 0);
      const latestSeq = messages.length
        ? messages[messages.length - 1]!.seq
        : (event.sinceSeq ?? 0);
      mobileRemote.broadcast({
        type: "room.history.ok",
        roomId: event.roomId,
        messages,
        latestSeq,
      });
      return;
    }
    if (event.type === "room.send") {
      const ok = roomManager.send(event.roomId, event.text);
      if (!ok)
        mobileRemote.broadcast({
          type: "room.error",
          roomId: event.roomId,
          message: "房间未就绪或已关闭",
        });
      return;
    }
  } catch (err) {
    mobileRemote.broadcast({
      type: "room.error",
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * CC Room (external `claude` CLI sessions) for mobile — mirrors the desktop
 * ccRoom:* IPC handlers, reusing the SAME core discovery + roomManager backend.
 * Discovery replies (probe/listSessions/readHistory) go per-device; open and
 * approval-response feed the shared roomManager / approvalBridge (the room is
 * dual-ended, like desktop). listSessions echoes the cwd so a phone that has
 * since switched projects can discard a stale reply.
 */
async function handleCcRoomEvent(event: AuthenticatedMobileClientEvent): Promise<void> {
  const deviceId = event.deviceId;
  const reply = (e: MobileServerEvent): void => {
    if (deviceId) mobileRemote.sendToDevice(deviceId, e);
    else mobileRemote.broadcast(e);
  };
  try {
    if (event.type === "ccRoom.probe") {
      const kind = event.kind ?? "claude-code";
      const a = await (kind === "codex" ? probeCodexCli : probeClaudeCli)(Boolean(event.force));
      reply({
        type: "ccRoom.probe.ok",
        available: a.available,
        command: a.command,
        version: a.version,
        reason: a.reason,
        kind,
      });
      return;
    }
    if (event.type === "ccRoom.listSessions") {
      const kind = event.kind ?? "claude-code";
      // Bound the mobile list too (recent 2 weeks AND ≤20) — phones especially
      // shouldn't pull + deep-read an entire project's session history.
      const opts = { limit: DEFAULT_DISCOVER_LIMIT, sinceMs: DEFAULT_DISCOVER_SINCE_MS };
      const sessions =
        kind === "codex"
          ? discoverCodexSessions(event.cwd, undefined, opts)
          : discoverSessions(event.cwd, undefined, opts);
      reply({ type: "ccRoom.listSessions.ok", cwd: event.cwd, sessions, kind });
      return;
    }
    if (event.type === "ccRoom.openSession") {
      const mode = await resolveRoomPermissionMode(event.cwd, event.mode);
      const { roomId, status } = roomManager.openForSession(
        event.sessionId,
        event.cwd,
        mode,
        event.kind ?? "claude-code",
      );
      reply({ type: "ccRoom.opened", roomId, sessionId: event.sessionId, status });
      return;
    }
    if (event.type === "ccRoom.subscribeTranscript") {
      const kind = event.kind ?? "claude-code";
      if (!roomMatchesTranscript(event.roomId, event.cwd, event.sessionId, kind)) {
        throw new Error("cc-room transcript subscription does not match the opened room");
      }
      const snapshot = transcriptSubscriptions!.subscribe({
        subscriberId: mobileTranscriptSubscriberId(event.viewerId ?? ""),
        roomId: event.roomId,
        cwd: event.cwd,
        sessionId: event.sessionId,
        kind,
        limit: event.limit,
      });
      reply({
        type: "ccRoom.transcriptSubscribed",
        roomId: event.roomId,
        sessionId: event.sessionId,
        ...snapshot,
      });
      return;
    }
    if (event.type === "ccRoom.unsubscribeTranscript") {
      transcriptSubscriptions!.unsubscribe(
        mobileTranscriptSubscriberId(event.viewerId ?? ""),
        event.roomId,
      );
      return;
    }
    if (event.type === "ccRoom.readHistory") {
      const h =
        event.kind === "codex"
          ? readCodexRecentHistory(event.cwd, event.sessionId, event.limit)
          : readRecentHistory(event.cwd, event.sessionId, event.limit);
      reply({
        type: "ccRoom.readHistory.ok",
        sessionId: event.sessionId,
        messages: h.messages,
        hasMore: h.hasMore,
        totalCount: h.totalCount,
      });
      return;
    }
    if (event.type === "ccRoom.respondApproval") {
      approvalBridge.respond(event.roomId, event.requestId, event.decision);
      return;
    }
  } catch (err) {
    reply({ type: "room.error", message: err instanceof Error ? err.message : String(err) });
  }
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
  const pendingWebviewPartitions: string[] = [];
  win.webContents.on("will-attach-webview", (_e, webPreferences, params) => {
    delete (webPreferences as Record<string, unknown>).preload;
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
    pendingWebviewPartitions.push(String(params.partition));
  });
  win.webContents.on("did-attach-webview", (_e, guest) => {
    const partition = pendingWebviewPartitions.shift() ?? BROWSER_PARTITION;
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
    setImmediate(ptyReapDestroyed);
  });

  if (!bridge) {
    bridge = new AgentBridge(win);
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
  } else {
    bridge.attachWindow(win);
  }

  await installAppMenu(win);
  return win;
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

app.whenReady().then(async () => {
  writeSettingsSchemaAtStartup();
  void cleanupKnownAttachments();

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
ipcMain.handle("plugins:list", async (_e, cwd: string) => {
  if (typeof cwd !== "string") throw new Error("plugins:list requires cwd");
  return listPlugins(cwd);
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
        dlog("browser", "register_session_bucket_rejected", {
          sessionId,
          reason: "no main-owned mapping",
        });
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
  return uninstallPluginEntry(pluginName, marketplaceName);
});
ipcMain.handle("plugins:uninstallLocal", async (_e, name: string) => {
  return uninstallLocalPluginEntry(name);
});
ipcMain.handle("plugins:update", async (_e, name: string) => {
  return updatePluginEntry(name);
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
ipcMain.handle("plugins:installLocal", async (_e, input: { kind: "dir" | "zip"; path: string }) =>
  installLocalPluginForUi(input),
);
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
ipcMain.handle(
  "attachments:stageImageDataUrl",
  async (
    _e,
    payload: {
      cwd?: string;
      sessionId?: string;
      name?: string;
      mime?: string;
      dataUrl?: string;
      origin?: string;
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
    return stageImageDataUrl({
      cwd: payload.cwd,
      sessionId: payload.sessionId,
      name: payload.name,
      mime: payload.mime,
      dataUrl: payload.dataUrl,
      origin,
    });
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
    _e,
    payload: {
      cwd?: string;
      sessionId?: string;
      attachments?: Array<Parameters<typeof markAttachmentsSent>[2][number]>;
    },
  ) => {
    if (!payload || typeof payload.cwd !== "string" || typeof payload.sessionId !== "string") {
      throw new Error("attachments:markSent requires cwd and sessionId");
    }
    const attachments = Array.isArray(payload.attachments) ? payload.attachments : [];
    await markAttachmentsSent(payload.cwd, payload.sessionId, attachments);
    return { ok: true };
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
  return probeMcpServers(configs, { force: Boolean(force) });
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

ipcMain.handle("mobileRemote:start", async (_e, opts?: { mode?: "lan" | "tunnel" }) => {
  if (mobileRemoteStartInFlight) return mobileRemoteStartInFlight;
  const run = (async () => {
    const mode = opts?.mode ?? "lan";
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
        tunnelManager.stop();
        await mobileRemote.stop();
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
});
ipcMain.handle("mobileRemote:stop", async () => {
  tunnelManager.stop();
  await mobileRemote.stop();
});
// Mint a fresh pairing URL on the already-running host. Lets the UI regenerate
// the QR after a settings-page remount (pairingUrl is renderer-local state and
// is lost on navigation) without restarting the host.
ipcMain.handle("mobileRemote:pairingUrl", async () => {
  const pairing = mobileRemote.createPairingUrl();
  return { pairingUrl: pairing.url, expiresAt: pairing.expiresAt };
});
ipcMain.handle("mobileRemote:status", async () => {
  const status = mobileRemote.status();
  return {
    running: Boolean(status),
    url: status?.url,
    mode: status?.mode,
    tunnelRunning: tunnelManager.isRunning(),
    tunnelConnected: tunnelManager.isConnected(),
  };
});
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
  mobileProjects = normalizeMobileProjects(projects);
  await sendMobileProjectList();
  return true;
});
ipcMain.handle("mobileRemote:updatePermissionModes", async (_e, entries: unknown) => {
  const next = normalizePermissionModeSnapshot(entries);
  mobilePermissionModes.clear();
  for (const entry of next) mobilePermissionModes.set(entry.sessionId, entry.mode);
  sendSelectedMobilePermissionModes();
  return true;
});
ipcMain.handle(
  "mobileRemote:approvalResolved",
  async (_e, input: { requestId?: unknown; sessionId?: unknown; approved?: unknown }) => {
    const requestId = typeof input?.requestId === "string" ? input.requestId : "";
    if (!requestId) return false;
    broadcastApprovalResolved({
      requestId,
      sessionId: typeof input?.sessionId === "string" ? input.sessionId : undefined,
      approved: typeof input?.approved === "boolean" ? input.approved : undefined,
    });
    return true;
  },
);

// ── Projects (disk recents = source of truth; renderer is a projection) ─────
ipcMain.handle("projects:list", async () => mobileProjectList());
ipcMain.handle("projects:resolveRoot", async (_e, path: string) => {
  const root = resolveProjectRoot(path);
  return { path: root, name: basename(root) };
});
ipcMain.handle("projects:add", async (_e, project: { path: string; name: string }) => {
  const path = resolveProjectRoot(project.path);
  await pushRecent({ path, name: project.name || basename(path), lastOpenedAt: Date.now() });
  await broadcastProjects();
});
ipcMain.handle("projects:remove", async (_e, projectPath: string) => {
  await softDelete(projectPath);
  await broadcastProjects();
});
ipcMain.handle("projects:setPinned", async (_e, projectPath: string, pinned: boolean) => {
  await setPinned(projectPath, pinned);
  await broadcastProjects();
});

// ── Rooms (desktop side; same RoomManager the phone uses → dual-ended) ──────
ipcMain.handle("rooms:list", async () => roomManager.listRooms().map(roomToPublic));
ipcMain.handle("rooms:projects", async () => mobileProjectList());
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
    return roomToPublic(room);
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
    if (!roomMatchesTranscript(roomId, cwd, sessionId, kind)) {
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
  const list = await switchSessionWorkspaceForUi(sessionId, cwd, target);
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
    const list = await cleanupSessionWorktreeForUi(sessionId, cwd, worktreePath, action);
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

ipcMain.handle("settings:get", async (_e, scope: SettingsScope, cwd?: string) => {
  if (scope !== "user" && scope !== "project") throw new Error("invalid scope");
  return readSettings(scope, cwd);
});

ipcMain.handle(
  "settings:set",
  async (_e, scope: SettingsScope, patch: Record<string, unknown>, cwd?: string) => {
    if (scope !== "user" && scope !== "project") throw new Error("invalid scope");
    if (!patch || typeof patch !== "object") throw new Error("patch must be object");
    await writeSettings(scope, patch, cwd);
    // git.path may have changed — re-apply to core's git resolver immediately.
    if ("git" in patch) void applyGitPathFromSettings();
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
  bridge?.closeSession(id);
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
ipcMain.handle("quickChat:claimSession", async (event, id: string) => {
  if (typeof id !== "string" || !/^qchat-[A-Za-z0-9.-]+$/.test(id)) {
    throw new Error("quick-chat session id required");
  }
  const ownerId = event.sender.id;
  quickChatOwnership.claim(id, ownerId);
  if (!quickChatOwnerCleanupRegistered.has(ownerId)) {
    quickChatOwnerCleanupRegistered.add(ownerId);
    event.sender.once("destroyed", () => {
      quickChatOwnerCleanupRegistered.delete(ownerId);
      quickChatOwnership.releaseOwner(ownerId);
    });
  }
});
ipcMain.handle("quickChat:cleanupSession", async (event, id: string) => {
  if (typeof id !== "string" || !/^qchat-[A-Za-z0-9.-]+$/.test(id)) {
    throw new Error("quick-chat session id required");
  }
  return quickChatOwnership.cleanup(id, event.sender.id, () => deleteDesktopSession(id));
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

app.on("before-quit", () => {
  bridge?.kill();
  automationHandle?.stop();
  automationHandle = null;
  ptyKillAll();
  transcriptSubscriptions?.closeAll();
  roomManager.closeAll();
  tunnelManager.stop();
  void mobileRemote.stop();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) void createWindow();
});
