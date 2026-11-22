import { app, BrowserWindow, Notification, session, webContents } from "electron";
import { join, resolve } from "node:path";
import { setDefaultCredentialCipher, sweepStaleCredentialCookies } from "@cjhyy/code-shell-core";
import { createLinkService } from "@cjhyy/code-shell-server/links";
import { prepareDesktopRuntimePath } from "./runtime-path.js";
import { dlog } from "../desktop-logger.js";
import { DesktopNotifier } from "../desktop-notifier.js";
import { showSystemNotification } from "../system-notification.js";
import { SafeStorageCipher } from "../credential-cipher.js";
import { migrateKnownCredentialStores } from "../credential-migration.js";
import { getProjectStore } from "../project-store.js";
import type { createDesktopHost } from "../desktop-host/main.js";
import { installThemeAssetProtocol } from "../theme-asset-protocol.js";
import { MEDIA_PREVIEW_SCHEME } from "../../shared/media-preview.js";
import {
  chromeExtensionRuntimeService,
  installChromeNativeMessagingHost,
  type ChromeNativeRegistrationResult,
} from "../browser-runtime/index.js";
import { removeOrphanedExternalRuntimePartitions } from "../orphaned-browser-partitions.js";
import { runOwnedQuickChatStartupCleanup } from "../quick-chat-startup-cleanup.js";
import { initUpdater } from "../updater.js";
import { sweepStaleLeases } from "../credentials-service.js";
import { applyGitPathFromSettings } from "../git-path-settings.js";
import { installWorkbenchTray } from "../workbench-tray.js";
import { warmTrustCache } from "../trust-store.js";

interface NativeStartup {
  ownsDesktopInstance: boolean;
  mainDirectory: string;
  desktopHost: Pick<ReturnType<typeof createDesktopHost>, "start" | "callBusiness">;
  revealSessionWindow(sessionId: string): void;
  notifierReady(notifier: DesktopNotifier): void;
  mediaResponse(request: Request): Promise<Response>;
  startMimi(): Promise<void>;
  startGateway(): Promise<void>;
  startPanelMedia(): Promise<unknown>;
  restoreMainWindow(): Promise<BrowserWindow>;
  startAutomations(initialWindowReady: Promise<BrowserWindow>): Promise<void>;
  sweepWorktrees(trigger: "startup" | "interval"): Promise<unknown>;
}

export function registerNativeStartup(options: NativeStartup) {
  let chromeRegistration: ChromeNativeRegistrationResult | undefined;
  let firstSweep: ReturnType<typeof setTimeout> | undefined;
  let recurringSweep: ReturnType<typeof setInterval> | undefined;
  let stopping = false;
  const quickChatsReady = app.whenReady().then(async () => {
    if (!options.ownsDesktopInstance || stopping) return;
    options.desktopHost.start(prepareDesktopRuntimePath());
    const removed = await runOwnedQuickChatStartupCleanup(options.ownsDesktopInstance, () =>
      options.desktopHost.callBusiness("startup/quickChats", {}),
    ).catch((error) => {
      dlog("main", "quick_chat.startup_cleanup_failed", { error: String(error) });
      return [];
    });
    if (removed.length) dlog("main", "quick_chat.startup_cleanup_done", { sessionIds: removed });
  });
  void app.whenReady().then(async () => {
    const { ownsDesktopInstance, desktopHost, revealSessionWindow, restoreMainWindow } = options;
    if (!ownsDesktopInstance || stopping) return;
    options.notifierReady(
      new DesktopNotifier(resolve(app.getPath("userData"), "notifications", "delivered.json"), {
        hasFocusedWindow: () => BrowserWindow.getFocusedWindow() !== null,
        isSupported: () => Notification.isSupported(),
        show: (input) => showSystemNotification(input, revealSessionWindow),
      }),
    );
    await getProjectStore().warm();
    if (stopping) return;
    void desktopHost.callBusiness("startup/settingsSchema", {}).catch(() => undefined);
    void desktopHost
      .callBusiness("startup/cleanupAttachments", {})
      .catch((error) => dlog("main", "attachments.cleanup.failed", { error: String(error) }));
    // The main window and the pet popout both render on the default session, so
    // one handler there serves cstheme:// assets to every window.
    installThemeAssetProtocol();
    session.defaultSession.protocol.handle(MEDIA_PREVIEW_SCHEME, (request) =>
      options.mediaResponse(request),
    );

    await chromeExtensionRuntimeService.start().catch((error) => {
      dlog("browser", "chrome_extension_bridge_start_failed", { error: String(error) });
    });
    if (stopping) return;
    await options.startMimi();
    if (stopping) return;
    chromeRegistration = await installChromeNativeMessagingHost({
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

    if (stopping) return;
    // Electron safeStorage and migration of existing credentials use the native cipher.
    setDefaultCredentialCipher(new SafeStorageCipher());
    // IM operations await their gateway boot. Opening an ordinary workbench does not need it.
    void options.startGateway();
    // Retired Link grants must resume cleanup even if no credentials page is opened.
    const linkCleanup = createLinkService();
    app.once("will-quit", () => linkCleanup.close());
    void desktopHost
      .callBusiness("startup/workspaces", {})
      .then((cwds) => migrateKnownCredentialStores(cwds))
      .then((result) => dlog("credentials", "migration.done", { ...result }))
      .catch((err) => dlog("credentials", "migration.failed", { error: String(err) }));

    // External-runtime sessions browse in the project bucket now; their old
    // per-session partitions are never opened again. Before any window exists.
    const partitionsDir = join(app.getPath("userData"), "Partitions");
    void removeOrphanedExternalRuntimePartitions({
      partitionsDir,
      inUse: (directory) =>
        webContents
          .getAllWebContents()
          .some(
            (contents) => !contents.isDestroyed() && contents.session.storagePath === directory,
          ),
    }).then((result) => {
      // Counts only: a directory name carries a session id.
      if (result.removed + result.inUse + result.failed > 0)
        dlog("browser", "orphaned-partitions.cleanup", { ...result });
    });

    if (process.platform === "darwin" && app.dock) {
      try {
        app.dock.setIcon(resolve(options.mainDirectory, "..", "..", "build", "icon.png"));
      } catch {
        // dev-only nicety; ignore if the asset is missing in some build paths
      }
    }
    // Prime the workspace-trust cache so the agent-bridge's synchronous
    // agent/run handler can resolve project trust without a disk read. Until it
    // resolves, unknown → fail-closed (untrusted), which is the safe default.
    void warmTrustCache()
      .then(() => (stopping ? undefined : options.startPanelMedia()))
      .catch((error) => dlog("main", "panel.media.recovery.failed", { error: String(error) }));
    // Share the restorer with `activate`: a Dock click queued during a blocked
    // startup would otherwise open a second main window before this one registers.
    if (stopping) return;
    installWorkbenchTray(restoreMainWindow);
    const initialWindowReady = restoreMainWindow();
    initUpdater();
    sweepStaleLeases(); // clear any cookie-lease temp files left by a prior crash
    sweepStaleCredentialCookies(); // clear UseCredential temp cookies.txt left by a prior crash

    void applyGitPathFromSettings();

    await options.startAutomations(initialWindowReady);
    if (stopping) return;
    // Defer initial sweep so the renderer has a chance to push current
    // git prefs via `git:setPrefs` first. Subsequent sweeps run hourly.
    firstSweep = setTimeout(() => void options.sweepWorktrees("startup"), 5_000);
    recurringSweep = setInterval(() => void options.sweepWorktrees("interval"), 60 * 60_000);
  });
  return {
    quickChatsReady,
    chromeRegistration: () => chromeRegistration,
    stop() {
      stopping = true;
      clearTimeout(firstSweep);
      clearInterval(recurringSweep);
    },
  };
}
