import type {
  BrowserWindow,
  BrowserWindowConstructorOptions,
  WebContents,
  WebContentsView,
  WebContentsViewConstructorOptions,
} from "electron";
import type { PanelAppBridge, PanelAppWindowSource } from "./panel-app-bridge.js";
import type { PanelAppProtocolResource } from "./panel-app-protocol.js";
import type { PanelAppWindowTarget, PreparedPanelApp } from "../shared/panel-apps.js";

interface Options {
  bridge: Pick<
    PanelAppBridge,
    | "getWindowSource"
    | "subscribeWindowSource"
    | "registerGuest"
    | "bindWindowGuest"
    | "revokeGuest"
  >;
  prepare: (id: string, projectPath: string) => Promise<PreparedPanelApp>;
  validateEntry: (url: string) => PanelAppProtocolResource | null;
  ownerWindow: (id: number) => BrowserWindow | null;
  createWindow: (options: BrowserWindowConstructorOptions) => BrowserWindow;
  createView: (options: WebContentsViewConstructorOptions) => WebContentsView;
  preloadPath: string;
}

interface OpenWindow {
  source: PanelAppWindowSource;
  ready: Promise<void>;
  sync: Promise<void>;
  win?: BrowserWindow;
  view?: WebContentsView;
  closed: boolean;
  loaded: boolean;
  unsubscribe?: () => void;
  detachOwner?: () => void;
}

/**
 * A separate Panel view, scoped to a live source tab. The window contains only
 * the sandboxed Panel preload; it is never a trusted Desktop renderer or a
 * Session stream owner. The source remains mounted with its transient state.
 */
export class PanelAppWindows {
  private readonly windows = new Map<number, OpenWindow>();

  constructor(private readonly options: Options) {}

  async open(sender: WebContents, target: PanelAppWindowTarget): Promise<void> {
    // Always revalidate, including repeated requests for an existing window.
    const source = this.options.bridge.getWindowSource(sender, target);
    const existing = this.windows.get(source.guestId);
    if (existing) {
      await existing.ready;
      await this.focus(existing);
      return;
    }
    const record: OpenWindow = {
      source,
      ready: Promise.resolve(),
      sync: Promise.resolve(),
      closed: false,
      loaded: false,
    };
    this.windows.set(source.guestId, record);
    record.ready = this.create(record);
    await record.ready;
    await this.focus(record);
  }

  private async focus(record: OpenWindow): Promise<void> {
    if (record.closed || !record.win || record.win.isDestroyed()) {
      throw new Error("Panel window is no longer available");
    }
    if (record.win.isMinimized()) record.win.restore();
    record.win.show();
    record.win.focus();
    record.view?.webContents.focus();
    await this.sync(record);
    if (record.closed) throw new Error("Panel source is no longer available");
  }

  private sync(record: OpenWindow): Promise<void> {
    record.sync = record.sync
      .then(async () => {
        if (record.loaded && !record.closed && record.view) {
          await this.options.bridge.bindWindowGuest(
            record.view.webContents.id,
            record.source.guestId,
          );
        }
      })
      .catch(() => this.close(record));
    return record.sync;
  }

  private async create(record: OpenWindow): Promise<void> {
    const { source } = record;
    try {
      const owner = this.options.ownerWindow(source.ownerWindowId);
      if (!owner || owner.isDestroyed()) throw new Error("Panel source window is unavailable");
      const ownerClosed = () => this.close(record);
      owner.once("closed", ownerClosed);
      record.detachOwner = () => owner.removeListener("closed", ownerClosed);
      record.unsubscribe = this.options.bridge.subscribeWindowSource(
        source.guestId,
        () => {
          if (record.loaded && !record.closed) void this.sync(record);
        },
        () => this.close(record),
      );
      const prepared = await this.options.prepare(
        source.descriptor.id,
        source.bindInput.projectPath,
      );
      if (record.closed) throw new Error("Panel source closed while opening its window");
      const resource = this.options.validateEntry(prepared.src);
      if (
        !resource ||
        resource.descriptor.id !== source.descriptor.id ||
        resource.descriptor.hostId !== source.descriptor.hostId ||
        prepared.revision !== source.descriptor.revision ||
        resource.descriptor.revision !== prepared.revision
      ) {
        throw new Error("Panel App changed; reopen the source Panel before opening a window");
      }
      const dark = source.bindInput.theme === "dark";
      const win = this.options.createWindow({
        width: 1100,
        height: 800,
        minWidth: 480,
        minHeight: 360,
        title: source.descriptor.title,
        show: false,
        backgroundColor: dark ? "#171717" : "#ffffff",
        // The empty native container has no Desktop bridge or page privileges.
        webPreferences: {
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          webviewTag: false,
          javascript: false,
        },
      });
      record.win = win;
      win.setMenu(null);
      win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      win.webContents.on("will-navigate", (event) => event.preventDefault());
      win.on("closed", () => this.close(record));
      const visibilityChanged = () => {
        if (record.loaded && !record.closed) void this.sync(record);
      };
      win.on("show", visibilityChanged);
      win.on("hide", visibilityChanged);
      win.on("minimize", visibilityChanged);
      win.on("restore", visibilityChanged);
      const view = this.options.createView({
        webPreferences: {
          preload: this.options.preloadPath,
          partition: prepared.partition,
          contextIsolation: true,
          nodeIntegration: false,
          nodeIntegrationInSubFrames: false,
          sandbox: true,
          webSecurity: true,
          webviewTag: false,
        },
      });
      record.view = view;
      this.options.bridge.registerGuest(
        view.webContents,
        win,
        resource,
        source.bindInput.projectPath,
      );
      win.contentView.addChildView(view);
      const resize = () => {
        if (record.closed || win.isDestroyed()) return;
        const [width, height] = win.getContentSize();
        view.setBounds({ x: 0, y: 0, width, height });
      };
      win.on("resize", resize);
      resize();
      view.webContents.on("render-process-gone", () => this.close(record));
      view.webContents.once("destroyed", () => this.close(record));
      // Binding before load associates the guest with its source before any
      // guest script can submit work. Context is also readable via context.get.
      await this.options.bridge.bindWindowGuest(view.webContents.id, source.guestId);
      if (record.closed) throw new Error("Panel source closed while opening its window");
      await view.webContents.loadURL(prepared.src);
      if (record.closed) throw new Error("Panel window closed while loading");
      record.loaded = true;
      await this.options.bridge.bindWindowGuest(view.webContents.id, source.guestId);
    } catch (error) {
      this.close(record);
      throw error;
    }
  }

  private close(record: OpenWindow): void {
    if (record.closed) return;
    record.closed = true;
    if (this.windows.get(record.source.guestId) === record) {
      this.windows.delete(record.source.guestId);
    }
    record.unsubscribe?.();
    record.detachOwner?.();
    if (record.view) {
      const guest = record.view.webContents;
      this.options.bridge.revokeGuest(guest.id);
      // WebContentsView contents are not destroyed automatically with a window.
      if (!guest.isDestroyed()) guest.close({ waitForBeforeUnload: false });
    }
    if (record.win && !record.win.isDestroyed()) record.win.destroy();
  }
}
