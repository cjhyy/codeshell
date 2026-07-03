/**
 * Auto-update via electron-updater.
 *
 * Update feed URL comes from the env var CODESHELL_UPDATE_FEED at
 * launch time, or falls back to the `publish` block in package.json
 * (when present) that `electron-builder` writes for you on `dist`.
 *
 * If neither is configured, electron-updater cannot discover the
 * update feed and reports a configuration error.
 *
 * Lifecycle events fan out to all known BrowserWindows via the
 * channel `updater:status`. The renderer can subscribe through
 * `window.codeshell.onUpdaterStatus`.
 */

import { BrowserWindow, app } from "electron";
import { autoUpdater } from "electron-updater";
import { dlog } from "./desktop-logger.js";

export type UpdaterStatus =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "available"; version: string }
  | { kind: "not-available"; version: string }
  | { kind: "downloading"; percent: number; transferred: number; total: number }
  | { kind: "downloaded"; version: string }
  | { kind: "error"; message: string };

let lastStatus: UpdaterStatus = { kind: "idle" };
let configured = false;

function broadcast(): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (w.isDestroyed()) continue;
    w.webContents.send("updater:status", lastStatus);
  }
}

function set(status: UpdaterStatus): void {
  lastStatus = status;
  dlog("main", "updater.status", status as unknown as Record<string, unknown>);
  broadcast();
}

export function getLastStatus(): UpdaterStatus {
  return lastStatus;
}

export function initUpdater(): void {
  if (configured) return;
  configured = true;

  // Don't auto-update during dev or unpackaged runs — there's no
  // installer to swap and the channel makes no sense.
  if (!app.isPackaged) {
    dlog("main", "updater.skip.not_packaged", {});
    return;
  }

  const feed = process.env.CODESHELL_UPDATE_FEED;
  if (feed) {
    try {
      autoUpdater.setFeedURL({ provider: "generic", url: feed });
      dlog("main", "updater.feed.env", { feed });
    } catch (e) {
      dlog("main", "updater.feed.error", { message: (e as Error).message });
      set({ kind: "error", message: (e as Error).message });
      return;
    }
  }
  // If no feed is set, electron-updater will look for the `publish`
  // block emitted into app-update.yml by electron-builder.

  autoUpdater.allowPrerelease = app.getVersion().includes("-");

  // Manual-update policy: only CHECK + notify automatically. The user decides
  // when to download (downloadUpdate) and when to install (quitAndInstall) —
  // no silent background download, no install-on-quit.
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;

  autoUpdater.on("checking-for-update", () => set({ kind: "checking" }));
  autoUpdater.on("update-available", (info) =>
    set({ kind: "available", version: String((info as { version?: string }).version ?? "") }),
  );
  autoUpdater.on("update-not-available", (info) =>
    set({ kind: "not-available", version: String((info as { version?: string }).version ?? "") }),
  );
  autoUpdater.on("download-progress", (p) =>
    set({
      kind: "downloading",
      percent: Math.round(p.percent),
      transferred: p.transferred,
      total: p.total,
    }),
  );
  autoUpdater.on("update-downloaded", (info) =>
    set({ kind: "downloaded", version: String((info as { version?: string }).version ?? "") }),
  );
  autoUpdater.on("error", (e) =>
    set({ kind: "error", message: e instanceof Error ? e.message : String(e) }),
  );

  // First check shortly after launch; then every 6h. Track the handles and
  // clear them on quit so the periodic check doesn't keep firing (or hold a
  // reference) during shutdown. unref() also keeps them from blocking exit.
  const firstCheck = setTimeout(() => void checkForUpdate(), 30_000);
  const periodic = setInterval(() => void checkForUpdate(), 6 * 60 * 60 * 1000);
  firstCheck.unref?.();
  periodic.unref?.();
  app.on("before-quit", () => {
    clearTimeout(firstCheck);
    clearInterval(periodic);
  });
}

export async function checkForUpdate(): Promise<void> {
  if (!app.isPackaged) {
    set({ kind: "error", message: "auto-update only runs in packaged builds" });
    return;
  }
  try {
    await autoUpdater.checkForUpdates();
  } catch (e) {
    set({ kind: "error", message: (e as Error).message });
  }
}

/** User-triggered download (autoDownload is off). Only meaningful once an
 *  update is available; electron-updater emits download-progress → downloaded. */
export async function downloadUpdate(): Promise<void> {
  if (!app.isPackaged) {
    set({ kind: "error", message: "auto-update only runs in packaged builds" });
    return;
  }
  if (lastStatus.kind !== "available") return;
  try {
    await autoUpdater.downloadUpdate();
  } catch (e) {
    set({ kind: "error", message: (e as Error).message });
  }
}

export function quitAndInstall(): void {
  if (lastStatus.kind !== "downloaded") return;
  autoUpdater.quitAndInstall();
}
