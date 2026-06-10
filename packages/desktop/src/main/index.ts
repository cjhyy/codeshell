/**
 * Electron main entry — broker between renderer (ipcMain) and the
 * agent worker subprocess (stdio JSON-RPC). See agent-bridge.ts.
 */

import { app, BrowserWindow, dialog, ipcMain, session, shell, Notification } from "electron";
import { fileURLToPath } from "node:url";
import { dirname, resolve, basename, extname, isAbsolute } from "node:path";
import { readFile, lstat, writeFile } from "node:fs/promises";
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
  type AutomationHandle,
  resolveExternalAgentConfig,
} from "@cjhyy/code-shell-core";
import { AgentBridge } from "./agent-bridge.js";
import { buildDesktopAutomationRunner } from "./automation-host.js";
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
import { ptyStart, ptyWrite, ptyResize, ptyKill, ptyKillAll, ptyReapDestroyed } from "./pty-service.js";
import { RemoteHostManager } from "./mobile-remote/remote-host-manager.js";
import { TrustedDeviceStore } from "./mobile-remote/trusted-device-store.js";
import { CloudflaredBinary } from "./mobile-remote/cloudflared-binary.js";
import { TunnelManager } from "./mobile-remote/tunnel-manager.js";
import { AccessPasscode } from "./mobile-remote/access-passcode.js";
import type { MobileClientEvent, MobileServerEvent, RoomPublic } from "./mobile-remote/types.js";
import { RoomManager } from "./mobile-remote/room-manager.js";
import { ResidentAgentProcess } from "./mobile-remote/resident-agent.js";
import { buildSessionHistory } from "./mobile-remote/mobile-history.js";
import type { PermissionMode } from "./mobile-remote/types.js";
import { readDirectory, readFile as fsReadFile, fileExists as fsFileExists } from "./fs-service.js";
import {
  getGitStatus,
  getGitNumstat,
  getGitRangeChanges,
  getGitBranchBase,
  getGitBranches,
  getGitDiff,
  getGitRangeDiff,
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
} from "./desktop-services.js";
import { readSettings, writeSettings, type SettingsScope } from "./settings-service.js";
import {
  listMemory,
  readMemory,
  saveMemory,
  deleteMemory,
  type MemoryLevel,
  type SaveMemoryInput,
} from "./memory-service.js";
import { runDream } from "./dream-service.js";
import type { MemoryScope } from "@cjhyy/code-shell-core";
import { listSessions, deleteSession, getSessionTranscript, listDiskSessions } from "./sessions-service.js";
import { getSessionEvents } from "./rawTranscript.js";
import { listTitles, setTitle } from "./session-titles-store.js";
import { tailLog, type LogBucket } from "./logs-service.js";
import {
  installSkillFromDirectory,
  listSkills,
  readSkillBody,
  uninstallSkill,
} from "./skills-service.js";
import { listPlugins, uninstallPluginEntry } from "./plugins-service.js";
import {
  listMarketplacesForUi,
  loadMarketplaceForUi,
  addMarketplaceFromInput,
  removeMarketplaceForUi,
  installPluginForUi,
} from "./marketplace-service.js";
import {
  listCapabilities,
  setCapabilityEnabled,
  setCapabilityOverride,
} from "./capabilities-service.js";
import { searchFiles } from "./file-search-service.js";
import {
  listAgents,
  readAgentBody,
  saveAgent,
  deleteAgent,
} from "./agents-service.js";
import type { AgentDefinition } from "@cjhyy/code-shell-core";
import {
  inspectRepo,
  installFromGithub,
  type InstallFromGithubInput,
} from "./github-skill-service.js";
import { resolveModelMeta } from "./model-meta-service.js";
import { listRuns, getRun, deleteRunDir } from "./runs-service.js";
import { initUpdater, checkForUpdate, quitAndInstall, getLastStatus } from "./updater.js";
import { loadRecents, pushRecent } from "./recents-store.js";
import { loadWindowState, saveWindowState } from "./window-state-store.js";
import { getTrust, setTrust, type TrustLevel } from "./trust-store.js";
import { installAppMenu, refreshAppMenu } from "./menu.js";
import { seedDefaults } from "./seed-defaults.js";
import {
  probeMcpServers,
  invalidateMcpProbeCache,
  type McpServerConfig,
} from "./mcp-probe-service.js";
import { probeSearch, type SearchProbeInput } from "./search-probe-service.js";
import { probeImage, type ImageProbeInput } from "./image-probe-service.js";
import { parseDataUrl, suggestImageFilename } from "./image-save.js";

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
    // The remote host tags authenticated events with the sending device id
    // (see remote-host-manager: { ...event, deviceId }). Thread it through so
    // session selection / permission mode / replies are per-device.
    void handleMobileClientEvent(event as MobileClientEvent & { deviceId?: string });
  },
});

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
const roomManager = new RoomManager({
  rootDir: resolve(app.getPath("userData"), "mobile-remote", "rooms"),
  createAgent: (room, onEvent) =>
    new ResidentAgentProcess({
      command: "claude",
      cwd: room.cwd,
      permissionMode: room.permissionMode,
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
 * selection + permission mode, so two devices never clobber each other (a
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
  /** This device's permission-mode preset, applied to its next run. */
  permissionMode: PermissionMode;
}
const mobileDeviceStates = new Map<string, MobileDeviceState>();
function deviceState(deviceId: string): MobileDeviceState {
  let s = mobileDeviceStates.get(deviceId);
  if (!s) {
    s = { permissionMode: "default" };
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

/**
 * Inject a JSON-RPC request into the worker and resolve with its ACTUAL
 * response (result on success, or failure on a JSON-RPC error / timeout). The
 * worker's reply flows back through subscribeOutbound (the same lines mirrored
 * to mobile), so we correlate by request id rather than fabricating success — a
 * model.set for an invalid model or a rejected goal.extend must NOT be reported
 * to the phone as ok.
 */
function injectAndAwaitResult(
  b: AgentBridge,
  method: string,
  params: Record<string, unknown>,
): Promise<{ ok: true; result: unknown } | { ok: false; message: string }> {
  const id = `mobile-${method.replace(/\W+/g, "-")}-${Date.now()}`;
  return new Promise((resolveResult) => {
    let settled = false;
    const done = (v: { ok: true; result: unknown } | { ok: false; message: string }): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unsub();
      resolveResult(v);
    };
    const unsub = b.subscribeOutbound((line) => {
      try {
        const m = JSON.parse(line) as { id?: string; result?: unknown; error?: { message?: string } };
        if (m.id !== id) return;
        if (m.error) done({ ok: false, message: m.error.message ?? "worker rejected the request" });
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
async function handleMobileClientEvent(event: MobileClientEvent & { deviceId?: string }): Promise<void> {
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
  const st = deviceId ? deviceState(deviceId) : { permissionMode: "default" as PermissionMode };
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
    return;
  }
  if (event.type === "session.create") {
    // Mint a fresh session for THIS device and make it its active selection.
    st.sessionId = `mobile-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    st.selectedSessionId = st.sessionId;
    reply({ type: "chat.accepted", sessionId: st.sessionId });
    return;
  }
  if (event.type === "chat.send") {
    const sessionId = resolveSessionId(event.sessionId);
    const cwd = ctx.cwd ?? process.cwd();
    // Every phone chat turn is a normal CodeShell turn routed through the worker
    // run path. The device's permission-mode preset rides on the run.
    bridge.injectWorkerMessage(
      JSON.stringify({
        jsonrpc: "2.0",
        id: `mobile-run-${Date.now()}`,
        method: "agent/run",
        params: { task: event.text, cwd, sessionId, permissionMode: st.permissionMode },
      }),
    );
    // Tell THIS device which session its turn landed in.
    reply({ type: "chat.accepted", sessionId });
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
    bridge.injectWorkerMessage(
      JSON.stringify({
        jsonrpc: "2.0",
        id: `mobile-approve-${Date.now()}`,
        method: "agent/approve",
        params: { sessionId: resolveSessionId(event.sessionId), requestId: event.approvalId, decision },
      }),
    );
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
    reply({
      type: "session.list.ok",
      sessions: sessions.map((s) => ({
        id: s.id,
        title: s.title,
        cwd: s.cwd,
        updatedAt: s.updatedAt,
        origin: s.origin,
      })),
      activeSessionId: st.selectedSessionId ?? ctx.sessionId,
    });
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
  if (event.type === "permission.setMode") {
    // Per-device preset — does NOT affect other devices.
    st.permissionMode = event.mode;
    reply({ type: "permission.mode", sessionId: event.sessionId, mode: event.mode });
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
}

function roomToPublic(room: {
  id: string;
  name: string;
  cwd: string;
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
  const settings = ((await readSettings("user", cwd).catch(() => null)) ?? {}) as {
    externalAgents?: Parameters<typeof resolveExternalAgentConfig>[0];
  };
  const cfg = resolveExternalAgentConfig(settings.externalAgents).claudeCode;
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
async function handleRoomEvent(event: MobileClientEvent): Promise<void> {
  try {
    if (event.type === "room.list") {
      mobileRemote.broadcast({ type: "room.list.ok", rooms: roomManager.listRooms().map(roomToPublic) });
      return;
    }
    if (event.type === "room.projects") {
      const recents = await loadRecents().catch(() => []);
      mobileRemote.broadcast({
        type: "room.projects.ok",
        projects: recents.map((r) => ({ path: r.path, name: r.name })),
      });
      return;
    }
    if (event.type === "room.create") {
      const permissionMode = await resolveRoomPermissionMode(event.cwd, event.permissionMode);
      const room = roomManager.createRoom({
        name: event.name,
        cwd: event.cwd,
        permissionMode,
      });
      mobileRemote.broadcast({ type: "room.list.ok", rooms: roomManager.listRooms().map(roomToPublic) });
      mobileRemote.broadcast({ type: "room.opened", roomId: room.id, status: "missing" });
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
      const latestSeq = messages.length ? messages[messages.length - 1]!.seq : (event.sinceSeq ?? 0);
      mobileRemote.broadcast({ type: "room.history.ok", roomId: event.roomId, messages, latestSeq });
      return;
    }
    if (event.type === "room.send") {
      const ok = roomManager.send(event.roomId, event.text);
      if (!ok) mobileRemote.broadcast({ type: "room.error", roomId: event.roomId, message: "房间未就绪或已关闭" });
      return;
    }
  } catch (err) {
    mobileRemote.broadcast({ type: "room.error", message: err instanceof Error ? err.message : String(err) });
  }
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

  // Harden every <webview> guest the browser panel attaches: keep node off,
  // sandbox on, isolated context, web security on — the guest only renders
  // remote pages and must never gain Node or escape same-origin.
  win.webContents.on("will-attach-webview", (_e, webPreferences, params) => {
    delete (webPreferences as Record<string, unknown>).preload;
    webPreferences.nodeIntegration = false;
    webPreferences.nodeIntegrationInSubFrames = false;
    webPreferences.contextIsolation = true;
    webPreferences.sandbox = true;
    webPreferences.webSecurity = true;
    // No renderer-driven popups; strip the attribute and deny window.open on
    // the guest below. (params is a string attribute map — delete, don't set.)
    delete (params as Record<string, unknown>).allowpopups;
    // Persist a shared session so logins survive across tabs/restarts.
    if (!params.partition) params.partition = "persist:browser";
  });
  // Gate the guest's navigation/popups once attached: deny window.open, and
  // refuse non-web schemes (file:, etc.) — the panel is for http(s) only.
  win.webContents.on("did-attach-webview", (_e, guest) => {
    guest.setWindowOpenHandler(({ url }) => {
      if (/^https?:/i.test(url)) void shell.openExternal(url);
      return { action: "deny" };
    });
    guest.on("will-navigate", (ev, url) => {
      if (!/^(https?|about):/i.test(url)) ev.preventDefault();
    });
  });

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
    bridge.subscribeOutbound((line) => {
      mobileRemote.broadcastRaw(line);
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
  popoutParents.set(win.webContents.id, parent.id);
  win.on("closed", () => popoutParents.delete(win.webContents.id));

  const query: Record<string, string> = { popout: "browser" };
  if (initialUrl) query.url = initialUrl;
  const devUrl = process.env.VITE_DEV_URL;
  if (devUrl) {
    const u = new URL(devUrl);
    for (const [k, v] of Object.entries(query)) u.searchParams.set(k, v);
    await win.loadURL(u.toString());
  } else {
    await win.loadFile(resolve(__dirname, "..", "renderer", "index.html"), { query });
  }
}

app.whenReady().then(() => {
  if (process.platform === "darwin" && app.dock) {
    try {
      app.dock.setIcon(resolve(__dirname, "..", "..", "build", "icon.png"));
    } catch {
      // dev-only nicety; ignore if the asset is missing in some build paths
    }
  }
  void createWindow();
  initUpdater();

  // First-run defaults: copy bundled agents + register seed marketplace
  // sources into ~/.code-shell. best-effort, fully self-guarded — never blocks
  // the startup chain.
  void seedDefaults();

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
    }) => bridge?.broadcastAutomationSession(meta);
    automationHandle = startAutomation({
      store: new CronStore(defaultCronStorePath()),
      // Each fired job runs as a one-shot read-only headless Engine, which
      // auto-writes a full transcript.jsonl (like interactive chat). The emit
      // callback streams events to a live snapshot for renderer reconnect; the
      // announce callback fires once with cwd+title so the renderer can place
      // the live run in the right project sidebar group immediately.
      runner: buildDesktopAutomationRunner(emitAutomationEvent, announceAutomationSession),
    });
    // Expose the live scheduler to the automation IPC service (Phase 3 UI).
    setAutomationScheduler(automationHandle.scheduler);

    // Surface background-agent completions (incl. automation runs) as desktop
    // notifications when the app isn't focused, so unattended jobs are visible.
    agentNotificationBus.subscribe((_sessionId, event) => {
      try {
        if (BrowserWindow.getFocusedWindow()) return; // user is watching; skip
        const ok = event.status === "completed";
        new Notification({
          title: ok ? "自动化任务完成" : "自动化任务失败",
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

ipcMain.handle("skills:list", async (_e, cwd: string) => listSkills(cwd));
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
ipcMain.handle(
  "plugins:uninstall",
  async (_e, pluginName: string, marketplaceName: string) => {
    return uninstallPluginEntry(pluginName, marketplaceName);
  },
);
ipcMain.handle("marketplace:list", async () => listMarketplacesForUi());
ipcMain.handle("marketplace:load", async (_e, name: string) =>
  loadMarketplaceForUi(name),
);
ipcMain.handle("marketplace:add", async (_e, input: string) =>
  addMarketplaceFromInput(input),
);
ipcMain.handle("marketplace:remove", async (_e, name: string) =>
  removeMarketplaceForUi(name),
);
ipcMain.handle(
  "plugins:install",
  async (_e, pluginName: string, marketplaceName: string) =>
    installPluginForUi(pluginName, marketplaceName),
);
ipcMain.handle("skills:read", async (_e, filePath: string) => readSkillBody(filePath));
ipcMain.handle("files:search", async (_e, cwd: string, query: string) => {
  if (typeof cwd !== "string") throw new Error("files:search requires cwd");
  const q = typeof query === "string" ? query : "";
  return searchFiles(cwd, q);
});
ipcMain.handle(
  "skills:uninstall",
  async (_e, filePath: string, source: "user" | "project" | "plugin") => {
    if (typeof filePath !== "string") throw new Error("skills:uninstall requires filePath");
    if (source !== "user" && source !== "project" && source !== "plugin")
      throw new Error("invalid source");
    return uninstallSkill(filePath, source);
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

// Read an image file and return it as a base64 data: URL. The renderer can't
// load `file://` (default webSecurity blocks it, and the CSP only allows
// `img-src 'self' data:`), so inline image thumbnails (GenerateImage output,
// screenshots, generated SVGs surfaced from answer text) come through here
// instead. Returns null on any failure so the caller degrades to a link.
//
// We use lstat (not stat) and reject symlinks: a symlink with an image
// extension could otherwise point at a non-image file, a device/FIFO, or a
// secret outside the workspace, defeating the extension+size guards.
const IMG_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".bmp": "image/bmp",
  ".avif": "image/avif",
};
const MAX_IMAGE_BYTES = 25 * 1024 * 1024; // 25MB — guard against huge data URLs
ipcMain.handle("images:readDataUrl", async (_e, absPath: string): Promise<string | null> => {
  try {
    if (typeof absPath !== "string" || !isAbsolute(absPath)) return null;
    const mime = IMG_MIME[extname(absPath).toLowerCase()];
    if (!mime) return null; // not an image extension
    const info = await lstat(absPath); // lstat: don't follow symlinks
    if (!info.isFile() || info.size > MAX_IMAGE_BYTES) return null;
    const buf = await readFile(absPath);
    return `data:${mime};base64,${buf.toString("base64")}`;
  } catch {
    return null;
  }
});

// Save an image to a user-chosen location (Lightbox / attachment "download").
// Accepts the data URL the renderer already holds (works for generated images,
// pasted/dragged attachments, and file-backed thumbnails alike). Returns the
// saved path, or null if the user cancelled the dialog.
ipcMain.handle(
  "images:save",
  async (
    e,
    src: string,
    opts?: { name?: string; mime?: string },
  ): Promise<string | null> => {
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

ipcMain.handle(
  "skills:installFromGithub",
  async (_e, input: unknown) => {
    if (!input || typeof input !== "object") {
      throw new Error("skills:installFromGithub requires { inspection, selected, scope }");
    }
    const i = input as InstallFromGithubInput;
    if (!i.inspection || !i.selected) throw new Error("missing inspection/selected");
    if (i.scope !== "user" && i.scope !== "project") throw new Error("invalid scope");
    return installFromGithub(i);
  },
);

ipcMain.handle(
  "skills:installLocal",
  async (
    _e,
    sourceDir: string,
    scope: "user" | "project",
    cwd?: string,
    name?: string,
  ) => {
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

ipcMain.handle("mcp:listMerged", async (_e, rawBase: unknown, rawDisabledPlugins?: unknown) => {
  const base = rawBase && typeof rawBase === "object"
    ? (rawBase as Record<string, McpServerConfig>)
    : {};
  const disabledPlugins = Array.isArray(rawDisabledPlugins)
    ? rawDisabledPlugins.filter((x): x is string => typeof x === "string")
    : [];
  const merged = mergePluginMcpServers(base, disabledPlugins);
  return Object.fromEntries(
    Object.entries(merged).map(([name, cfg]) => [
      name,
      {
        ...cfg,
        name,
        source: Object.prototype.hasOwnProperty.call(base, name) ? "settings" : "plugin",
        editable: Object.prototype.hasOwnProperty.call(base, name),
      },
    ]),
  );
});

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
  const provider = rawProvider && typeof rawProvider === "object"
    ? rawProvider as Record<string, unknown>
    : {};
  const rawKind = typeof provider.kind === "string" ? provider.kind : "custom";
  const kind = Object.prototype.hasOwnProperty.call(PROVIDER_KINDS, rawKind)
    ? rawKind as ProviderKindName
    : "custom";
  const meta = PROVIDER_KINDS[kind];
  const rawBaseUrl = typeof provider.baseUrl === "string" && provider.baseUrl.trim()
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
ipcMain.handle("updater:install", async () => quitAndInstall());
ipcMain.handle("updater:status", async () => getLastStatus());

// ── Mobile Web Remote ───────────────────────────────────────────────────────
ipcMain.handle(
  "mobileRemote:start",
  async (_e, opts?: { mode?: "lan" | "tunnel" }) => {
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
        throw new Error(
          `公网隧道启动失败:${err instanceof Error ? err.message : String(err)}`,
          { cause: err },
        );
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
  },
);
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
    tunnelRunning: tunnelManager.isRunning(),
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
ipcMain.handle("mobileRemote:cloudflaredInstalled", async () =>
  cloudflaredBinary.isInstalled(),
);
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
}));

// ── Rooms (desktop side; same RoomManager the phone uses → dual-ended) ──────
ipcMain.handle("rooms:list", async () => roomManager.listRooms().map(roomToPublic));
ipcMain.handle("rooms:projects", async () => {
  const recents = await loadRecents().catch(() => []);
  return recents.map((r) => ({ path: r.path, name: r.name }));
});
ipcMain.handle(
  "rooms:create",
  async (
    _e,
    input: { name?: string; cwd: string; permissionMode?: "default" | "acceptEdits" | "bypassPermissions" },
  ) => {
    const permissionMode = await resolveRoomPermissionMode(input.cwd, input.permissionMode);
    const room = roomManager.createRoom({ name: input.name, cwd: input.cwd, permissionMode });
    return roomToPublic(room);
  },
);
ipcMain.handle("rooms:open", async (_e, roomId: string) => roomManager.open(roomId));
ipcMain.handle("rooms:close", async (_e, roomId: string) => {
  roomManager.close(roomId);
});
ipcMain.handle("rooms:send", async (_e, roomId: string, text: string) => roomManager.send(roomId, text));
ipcMain.handle("rooms:history", async (_e, roomId: string, sinceSeq?: number) =>
  roomManager.getMessages(roomId, sinceSeq ?? 0),
);

ipcMain.handle("dialog:pickDir", async (e): Promise<{ path: string; name: string } | null> => {
  const res = await dialog.showOpenDialog({
    title: "选择项目目录",
    properties: ["openDirectory", "createDirectory"],
  });
  if (res.canceled || res.filePaths.length === 0) return null;
  const path = res.filePaths[0];
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

ipcMain.handle("window:new", async () => {
  await createWindow();
});

// Open the standalone browser popout, parented to the requesting window so its
// element-pick anchors route back to that window's composer.
ipcMain.handle("browser:popout", async (e, initialUrl?: string) => {
  const parent = BrowserWindow.fromWebContents(e.sender);
  if (!parent) return;
  await createBrowserPopout(parent, typeof initialUrl === "string" ? initialUrl : undefined);
});

// A popout pinned an element anchor → forward it to the parent window's
// renderer, which dispatches the normal add-anchor flow into the composer.
ipcMain.on("browser:anchor", (e, anchor: unknown) => {
  const parentId = popoutParents.get(e.sender.id);
  if (parentId === undefined) return;
  const parent = BrowserWindow.fromId(parentId);
  if (parent && !parent.isDestroyed()) parent.webContents.send("browser:anchor-from-popout", anchor);
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
  if (typeof branch !== "string" || !branch) throw new Error("git:stashAndSwitchBranch requires branch");
  return stashAndSwitchGitBranch(cwd, branch);
});

ipcMain.handle(
  "git:createWorktree",
  async (_e, cwd: string, name: string, branchPrefix?: string) => {
    if (typeof cwd !== "string" || !cwd) throw new Error("git:createWorktree requires cwd");
    if (typeof name !== "string" || !name.trim()) throw new Error("git:createWorktree requires name");
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
  branchPrefix: "codeshell/",
  autoDeleteWorktrees: true,
  autoDeleteWorktreesGraceMins: 60 * 24 * 7,
};

ipcMain.handle("git:setPrefs", async (_e, prefs: MainGitPrefs) => {
  if (!prefs || typeof prefs !== "object") return;
  const grace = Number(prefs.autoDeleteWorktreesGraceMins);
  gitPrefsCache = {
    branchPrefix:
      typeof prefs.branchPrefix === "string" && prefs.branchPrefix.trim()
        ? prefs.branchPrefix
        : "codeshell/",
    autoDeleteWorktrees: prefs.autoDeleteWorktrees !== false,
    autoDeleteWorktreesGraceMins:
      Number.isFinite(grace) && grace >= 1 ? Math.floor(grace) : 60 * 24 * 7,
  };
  dlog("main", "git.prefs.updated", { ...gitPrefsCache });
});

const knownGitRoots = new Set<string>();

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
  for (const root of knownGitRoots) {
    try {
      const removed = await cleanupStaleWorktrees(root, grace);
      if (removed.length > 0) {
        dlog("main", "git.worktree.cleanup", { reason, root, removed });
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

ipcMain.handle("git:diff", async (_e, cwd: string, file?: string) => {
  if (typeof cwd !== "string" || !cwd) throw new Error("git:diff requires cwd");
  return getGitDiff(cwd, file);
});

ipcMain.handle("git:rangeDiff", async (_e, cwd: string, range: string, file?: string) => {
  if (typeof cwd !== "string" || !cwd) throw new Error("git:rangeDiff requires cwd");
  return getGitRangeDiff(cwd, range, file);
});

ipcMain.handle("shell:openExternal", async (_e, url: string) => {
  if (typeof url !== "string") throw new Error("openExternal requires url");
  await openExternal(url);
});

ipcMain.handle("shell:revealInFinder", async (_e, p: string) => {
  if (typeof p !== "string") throw new Error("revealInFinder requires path");
  await revealInFinder(p);
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
ipcMain.handle("pty:write", (_e, sessionId: string, data: string) => {
  ptyWrite(sessionId, data);
});
ipcMain.handle("pty:resize", (_e, sessionId: string, cols: number, rows: number) => {
  ptyResize(sessionId, cols, rows);
});
ipcMain.handle("pty:kill", (_e, sessionId: string) => {
  ptyKill(sessionId);
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

ipcMain.handle("settings:get", async (_e, scope: SettingsScope, cwd?: string) => {
  if (scope !== "user" && scope !== "project") throw new Error("invalid scope");
  return readSettings(scope, cwd);
});

ipcMain.handle("settings:set", async (_e, scope: SettingsScope, patch: Record<string, unknown>, cwd?: string) => {
  if (scope !== "user" && scope !== "project") throw new Error("invalid scope");
  if (!patch || typeof patch !== "object") throw new Error("patch must be object");
  await writeSettings(scope, patch, cwd);
});

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

ipcMain.handle(
  "memory:list",
  async (_e, level: unknown, scope: unknown, cwd?: string) => {
    const v = validateMemoryArgs(level, scope);
    return listMemory(v.level, v.scope, typeof cwd === "string" ? cwd : undefined);
  },
);

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

ipcMain.handle("memory:dream", async (_e, level: unknown, cwd?: string) => {
  if (level !== "user" && level !== "project") {
    throw new Error(`dream level must be "user" or "project", got ${String(level)}`);
  }
  return runDream(level, typeof cwd === "string" ? cwd : undefined);
});

ipcMain.handle("sessions:list", async () => listSessions());
ipcMain.handle("sessions:delete", async (_e, id: string) => {
  if (typeof id !== "string") throw new Error("session id required");
  // Reap the session's background shells (if any) before dropping it —
  // explicit delete is the one tab-close path that DOES kill (core §6).
  bridge?.closeSession(id);
  await deleteSession(id);
  // Drop any in-memory snapshot for the deleted session so it can't be
  // replayed into a fresh tab that happens to reuse the id.
  bridge?.forgetSession(id);
});

/**
 * Snapshot subscription: a (re)mounted renderer asks main for the events it
 * missed for a session past `sinceSeq`. main holds these (AgentBridge's
 * SessionSnapshotStore) precisely because it does not remount with the
 * renderer. Returns { events: [{seq,event}], nextSeq }.
 */
ipcMain.handle("agent:subscribe", async (_e, sessionId: string, sinceSeq?: number) => {
  if (typeof sessionId !== "string") throw new Error("sessionId required");
  return bridge?.getSnapshot(sessionId, typeof sinceSeq === "number" ? sinceSeq : 0)
    ?? { events: [], nextSeq: 1 };
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
  return listDiskSessions({ limit, cursor: typeof opts?.cursor === "string" ? opts.cursor : undefined });
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
  if (!input || typeof input.name !== "string" || typeof input.schedule !== "string" || typeof input.prompt !== "string") {
    throw new Error("name, schedule and prompt are required");
  }
  return createAutomation(input);
});
ipcMain.handle("automation:update", async (_e, id: string, patch: UpdateAutomationInput) => {
  if (typeof id !== "string") throw new Error("id required");
  if (!patch || typeof patch !== "object") throw new Error("patch required");
  return updateAutomation(id, patch);
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

ipcMain.handle("recents:list", async () => loadRecents());

ipcMain.handle("notify:show", async (_e, opts: { title: string; body?: string; subtitle?: string }) => {
  if (!opts || typeof opts.title !== "string") throw new Error("notify:show requires title");
  if (!Notification.isSupported()) return;
  new Notification(opts).show();
});

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
  roomManager.closeAll();
  tunnelManager.stop();
  void mobileRemote.stop();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) void createWindow();
});
