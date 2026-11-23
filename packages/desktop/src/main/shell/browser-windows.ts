import { BrowserWindow, ipcMain } from "electron";
import { resolve } from "node:path";
import { guestRecordForId, rememberAttachedGuest } from "../browser-driver/active-guest.js";
import { BROWSER_PARTITION } from "../credentials-service.js";
import { isProfileBrowserPartition } from "../../shared/browser-profile.js";
import {
  preparedPanelAppPartitionProjectPath,
  validatePanelAppEntryUrl,
} from "../panel-app-protocol.js";
import type { PanelAppBridge } from "../panel-app-bridge.js";
import type { AppRendererNavigation } from "../app-renderer-navigation.js";
import { registerBrowserPopoutIpc } from "../browser-popout-ipc.js";
import { dlog } from "../desktop-logger.js";

export function createBrowserWindowShell({
  mainWindows,
  panelAppBridge,
  appRendererNavigation,
  mainDirectory,
}: {
  mainWindows: Set<BrowserWindow>;
  panelAppBridge: Pick<PanelAppBridge, "registerGuest">;
  appRendererNavigation: Pick<AppRendererNavigation, "bind" | "assertSender">;
  mainDirectory: string;
}) {
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
        webPreferences.preload = resolve(mainDirectory, "..", "preload", "panel-app.cjs");
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
      webPreferences.preload = resolve(mainDirectory, "..", "preload", "browser-guest.cjs");
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
        preload: resolve(mainDirectory, "..", "preload", "index.cjs"),
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
    win.webContents.on("console-message", ({ level, message, lineNumber: line, sourceId }) => {
      if (level === "warning" || level === "error")
        dlog("main", "browser-popout.console", { level, message, line, sourceId });
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
        await win.loadFile(resolve(mainDirectory, "..", "renderer", "index.html"), { query });
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

  // Open the standalone browser popout, parented to the requesting window so its
  // element-pick anchors route back to that window's composer.
  ipcMain.handle("browser:popout", async (e, initialUrl?: string) => {
    appRendererNavigation.assertSender(e);
    const parent = BrowserWindow.fromWebContents(e.sender);
    if (!parent || !mainWindows.has(parent)) return;
    let normalizedUrl: string | undefined;
    if (initialUrl !== undefined) {
      if (
        typeof initialUrl !== "string" ||
        initialUrl.length > 8_192 ||
        initialUrl.includes("\0")
      ) {
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

  registerBrowserPopoutIpc({ mainWindows, popoutParents, browserAnchorsByParent });
  return { hardenWebviewGuests, releaseParent: (id: number) => browserAnchorsByParent.delete(id) };
}
