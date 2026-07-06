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

import { spawnSync } from "node:child_process";
import { BrowserWindow, app } from "electron";
import { autoUpdater } from "electron-updater";
import { dlog } from "./desktop-logger.js";
import { macSignatureNeedsManualInstall, releaseUrlForVersion } from "./updater-signature.js";
import { isNoUpdateManifestError, isReadOnlyInstallError } from "./updater-error-classify.js";

type ManualInstallReason = "mac-signature" | "mac-readonly-volume";

export type UpdaterStatus =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "available"; version: string }
  | { kind: "manual-required"; version: string; url: string; message: string; reason: ManualInstallReason }
  | { kind: "not-available"; version: string }
  | { kind: "downloading"; percent: number; transferred: number; total: number }
  | { kind: "downloaded"; version: string }
  | { kind: "installing"; version: string }
  | { kind: "error"; message: string };

let lastStatus: UpdaterStatus = { kind: "idle" };
let configured = false;
let macManualInstallRequired: boolean | undefined;
let downloadInFlight = false;
let activeDownloadVersion: string | null = null;
let downloadedVersion: string | null = null;
let installInFlight = false;

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

function macAppBundlePath(): string {
  const packagedAppPath = app.getAppPath();
  const appBundleMarker = ".app/";
  const appBundleIndex = packagedAppPath.indexOf(appBundleMarker);
  return appBundleIndex >= 0
    ? packagedAppPath.slice(0, appBundleIndex + ".app".length)
    : app.getPath("exe");
}

function macManualInstallReason(): ManualInstallReason | null {
  if (process.platform !== "darwin") return null;
  if (!app.isPackaged) return null;
  if (process.env.CODESHELL_FORCE_MAC_AUTO_UPDATE === "1") return null;

  const appPath = macAppBundlePath();
  const downloadsPath = app.getPath("downloads");
  if (
    appPath.startsWith("/Volumes/") ||
    appPath.includes("/AppTranslocation/") ||
    (downloadsPath && appPath.startsWith(`${downloadsPath}/`))
  ) {
    dlog("main", "updater.mac_manual.location", { appPath });
    return "mac-readonly-volume";
  }

  if (macManualInstallRequired !== undefined) {
    return macManualInstallRequired ? "mac-signature" : null;
  }

  const detail = spawnSync("codesign", ["-dv", "--verbose=4", appPath], {
    encoding: "utf8",
  });
  const requirement = spawnSync("codesign", ["-d", "-r-", appPath], {
    encoding: "utf8",
  });
  const text = [
    detail.stdout ?? "",
    detail.stderr ?? "",
    requirement.stdout ?? "",
    requirement.stderr ?? "",
  ].join("\n");
  if (!text.trim()) {
    dlog("main", "updater.mac_signature.unknown", {
      status: detail.status ?? null,
      error: detail.error?.message,
    });
    macManualInstallRequired = false;
    return null;
  }

  macManualInstallRequired = macSignatureNeedsManualInstall(text);
  dlog("main", "updater.mac_signature.detected", {
    manualInstallRequired: macManualInstallRequired,
  });
  return macManualInstallRequired ? "mac-signature" : null;
}

function manualRequiredStatus(version: string, reason: ManualInstallReason): UpdaterStatus {
  return {
    kind: "manual-required",
    version,
    url: releaseUrlForVersion(version),
    reason,
    message:
      reason === "mac-readonly-volume"
        ? "The app is running from a read-only or translocated location. Move it to Applications, or download and install the release manually."
        : "This macOS build is ad-hoc signed, so the in-app updater cannot replace the app safely. Download the DMG/zip and install it manually.",
  };
}

function availableStatus(version: string): UpdaterStatus {
  const reason = macManualInstallReason();
  return reason ? manualRequiredStatus(version, reason) : { kind: "available", version };
}

function versionFromStatus(status: UpdaterStatus): string | null {
  switch (status.kind) {
    case "available":
    case "manual-required":
    case "not-available":
    case "downloaded":
    case "installing":
      return status.version;
    default:
      return null;
  }
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

  autoUpdater.on("checking-for-update", () => {
    if (downloadInFlight || installInFlight || lastStatus.kind === "downloaded" || lastStatus.kind === "installing") return;
    set({ kind: "checking" });
  });
  autoUpdater.on("update-available", (info) => {
    const version = String((info as { version?: string }).version ?? "");
    if (downloadInFlight || installInFlight) return;
    if (version && downloadedVersion === version) {
      set({ kind: "downloaded", version });
      return;
    }
    if (lastStatus.kind === "downloaded" || lastStatus.kind === "installing") return;
    set(availableStatus(version));
  });
  autoUpdater.on("update-not-available", (info) => {
    if (downloadInFlight || installInFlight || lastStatus.kind === "downloaded" || lastStatus.kind === "installing") return;
    set({ kind: "not-available", version: String((info as { version?: string }).version ?? "") });
  });
  autoUpdater.on("download-progress", (p) => {
    if (!downloadInFlight) return;
    set({
      kind: "downloading",
      percent: Math.round(p.percent),
      transferred: p.transferred,
      total: p.total,
    });
  });
  autoUpdater.on("update-downloaded", (info) => {
    const version = String((info as { version?: string }).version ?? activeDownloadVersion ?? "");
    downloadInFlight = false;
    activeDownloadVersion = null;
    downloadedVersion = version || downloadedVersion;
    set({ kind: "downloaded", version });
  });
  autoUpdater.on("error", (e) => {
    const message = e instanceof Error ? e.message : String(e);
    if (isReadOnlyInstallError(message)) {
      const version = versionFromStatus(lastStatus) ?? downloadedVersion ?? activeDownloadVersion ?? app.getVersion();
      downloadInFlight = false;
      activeDownloadVersion = null;
      installInFlight = false;
      set(manualRequiredStatus(version, "mac-readonly-volume"));
      return;
    }
    if (!downloadInFlight && !installInFlight && lastStatus.kind === "downloaded") return;
    // A missing/404 manifest while merely CHECKING (not downloading/installing)
    // means "release still publishing / nothing available" — surface it as a
    // quiet not-available, not a scary error card.
    if (!downloadInFlight && !installInFlight && isNoUpdateManifestError(message)) {
      dlog("main", "updater.no_manifest", { message });
      set({ kind: "not-available", version: app.getVersion() });
      return;
    }
    downloadInFlight = false;
    activeDownloadVersion = null;
    installInFlight = false;
    set({ kind: "error", message });
  });

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
  if (
    downloadInFlight ||
    installInFlight ||
    lastStatus.kind === "downloading" ||
    lastStatus.kind === "downloaded" ||
    lastStatus.kind === "installing"
  ) return;
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
  if (
    downloadInFlight ||
    installInFlight ||
    lastStatus.kind === "downloading" ||
    lastStatus.kind === "downloaded" ||
    lastStatus.kind === "installing"
  ) return;
  if (lastStatus.kind !== "available") return;
  downloadInFlight = true;
  activeDownloadVersion = lastStatus.version;
  try {
    set({ kind: "downloading", percent: 0, transferred: 0, total: 0 });
    await autoUpdater.downloadUpdate();
  } catch (e) {
    downloadInFlight = false;
    activeDownloadVersion = null;
    set({ kind: "error", message: (e as Error).message });
  }
}

export function quitAndInstall(): void {
  if (lastStatus.kind !== "downloaded") return;
  if (installInFlight) return;
  installInFlight = true;
  const version = lastStatus.version;
  set({ kind: "installing", version });
  setImmediate(() => {
    try {
      autoUpdater.quitAndInstall(false, true);
    } catch (e) {
      installInFlight = false;
      set({ kind: "error", message: e instanceof Error ? e.message : String(e) });
    }
  });
}
