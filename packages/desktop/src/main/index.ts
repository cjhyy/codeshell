/**
 * Electron main entry — broker between renderer (ipcMain) and the
 * agent worker subprocess (stdio JSON-RPC). See agent-bridge.ts.
 */

import { app, BrowserWindow, dialog, ipcMain, session, shell, Notification } from "electron";
import { fileURLToPath } from "node:url";
import { dirname, resolve, basename, extname, isAbsolute } from "node:path";
import { readFile, lstat } from "node:fs/promises";
import {
  defaultCacheDir,
  fetchModelList,
  PROVIDER_KINDS,
  type ProviderKindName,
  startAutomation,
  CronStore,
  defaultCronStorePath,
  agentNotificationBus,
  type AutomationHandle,
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
  type CreateAutomationInput,
  type UpdateAutomationInput,
} from "./automation-service.js";
import { dlog } from "./desktop-logger.js";
import {
  getGitStatus,
  getGitBranches,
  getGitDiff,
  switchGitBranch,
  stashAndSwitchGitBranch,
  createPermanentWorktree,
  listGitWorktrees,
  cleanupStaleWorktrees,
  openExternal,
  revealInFinder,
  openPath,
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
import { listSessions, deleteSession, getSessionTranscript } from "./sessions-service.js";
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
import {
  probeMcpServers,
  invalidateMcpProbeCache,
  type McpServerConfig,
} from "./mcp-probe-service.js";
import { probeSearch, type SearchProbeInput } from "./search-probe-service.js";

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
    },
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
          "connect-src 'self'; " +
          "object-src 'none'; " +
          "base-uri 'none'; " +
          "frame-ancestors 'none'",
        ];
    session.defaultSession.webRequest.onHeadersReceived((details, cb) => {
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
  if (devUrl) {
    win.loadURL(devUrl);
    win.webContents.openDevTools({ mode: "right" });
  } else {
    win.loadFile(resolve(__dirname, "..", "renderer", "index.html"));
    if (!app.isPackaged) win.webContents.openDevTools({ mode: "right" });
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

  if (!bridge) {
    bridge = new AgentBridge(win);
  } else {
    bridge.attachWindow(win);
  }

  await installAppMenu(win);
  return win;
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

ipcMain.handle("models:resolve-meta", async (_e, models: unknown, providers: unknown) => {
  if (!Array.isArray(models) || !Array.isArray(providers)) return [];
  return resolveModelMeta(models as never, providers as never);
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

ipcMain.handle("git:status", async (_e, cwd: string) => {
  if (typeof cwd !== "string" || !cwd) throw new Error("git:status requires cwd");
  return getGitStatus(cwd);
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
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) void createWindow();
});
