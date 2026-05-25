/**
 * Electron main entry — broker between renderer (ipcMain) and the
 * agent worker subprocess (stdio JSON-RPC). See agent-bridge.ts.
 */

import { app, BrowserWindow, dialog, ipcMain, session, shell, Notification } from "electron";
import { fileURLToPath } from "node:url";
import { dirname, resolve, basename } from "node:path";
import {
  defaultCacheDir,
  fetchModelList,
  PROVIDER_KINDS,
  type ProviderKindName,
} from "@cjhyy/code-shell-core";
import { AgentBridge } from "./agent-bridge.js";
import { dlog } from "./desktop-logger.js";
import {
  getGitStatus,
  getGitBranches,
  getGitDiff,
  switchGitBranch,
  stashAndSwitchGitBranch,
  createPermanentWorktree,
  listGitWorktrees,
  openExternal,
  revealInFinder,
} from "./desktop-services.js";
import { readSettings, writeSettings, type SettingsScope } from "./settings-service.js";
import { listSessions, deleteSession } from "./sessions-service.js";
import { listTitles, setTitle } from "./session-titles-store.js";
import { tailLog, type LogBucket } from "./logs-service.js";
import {
  installSkillFromDirectory,
  listSkills,
  readSkillBody,
  uninstallSkill,
} from "./skills-service.js";
import { resolveModelMeta } from "./model-meta-service.js";
import { listRuns, getRun } from "./runs-service.js";
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

async function createWindow(): Promise<BrowserWindow> {
  const ws = await loadWindowState();

  const win = new BrowserWindow({
    width: ws.width,
    height: ws.height,
    x: ws.x,
    y: ws.y,
    icon: resolve(__dirname, "..", "..", "build", "icon.png"),
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
});

ipcMain.handle("skills:list", async (_e, cwd: string) => listSkills(cwd));
ipcMain.handle("skills:read", async (_e, filePath: string) => readSkillBody(filePath));
ipcMain.handle(
  "skills:uninstall",
  async (_e, filePath: string, source: "user" | "project" | "plugin") => {
    if (typeof filePath !== "string") throw new Error("skills:uninstall requires filePath");
    if (source !== "user" && source !== "project" && source !== "plugin")
      throw new Error("invalid source");
    return uninstallSkill(filePath, source);
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

ipcMain.handle("git:createWorktree", async (_e, cwd: string, name: string) => {
  if (typeof cwd !== "string" || !cwd) throw new Error("git:createWorktree requires cwd");
  if (typeof name !== "string" || !name.trim()) throw new Error("git:createWorktree requires name");
  return createPermanentWorktree(cwd, name);
});

ipcMain.handle("git:listWorktrees", async (_e, cwd: string) => {
  if (typeof cwd !== "string" || !cwd) throw new Error("git:listWorktrees requires cwd");
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

ipcMain.handle("settings:get", async (_e, scope: SettingsScope, cwd?: string) => {
  if (scope !== "user" && scope !== "project") throw new Error("invalid scope");
  return readSettings(scope, cwd);
});

ipcMain.handle("settings:set", async (_e, scope: SettingsScope, patch: Record<string, unknown>, cwd?: string) => {
  if (scope !== "user" && scope !== "project") throw new Error("invalid scope");
  if (!patch || typeof patch !== "object") throw new Error("patch must be object");
  await writeSettings(scope, patch, cwd);
});

ipcMain.handle("sessions:list", async () => listSessions());
ipcMain.handle("sessions:delete", async (_e, id: string) => {
  if (typeof id !== "string") throw new Error("session id required");
  await deleteSession(id);
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
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) void createWindow();
});
