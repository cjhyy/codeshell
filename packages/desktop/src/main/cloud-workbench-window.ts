import {
  app,
  BrowserWindow,
  desktopCapturer,
  dialog,
  session,
  shell,
  systemPreferences,
  webContents,
} from "electron";
import { createCloudWorkbenchDisplayCapture } from "./cloud-workbench-capture.js";
import { basename, join } from "node:path";
import {
  cloudId,
  cloudOrigin,
  cloudToken,
  managedCloudPartition,
  type ManagedCloudGrant,
} from "./cloud-management-contract.js";
import {
  cloudWorkbenchPartition,
  cloudWorkbenchBrowserHandoffUrl,
  createCloudWorkbenchNavigation,
  isCloudWorkbenchOrigin,
  normalizeCloudWorkbenchAddress,
} from "./cloud-workbench-policy.js";

// Entry targets keep separate windows; reopening focuses their current navigation state.
const windows = new Map<string, BrowserWindow>();
type PermissionCheck = NonNullable<Parameters<Electron.Session["setPermissionCheckHandler"]>[0]>;
type PermissionRequest = NonNullable<
  Parameters<Electron.Session["setPermissionRequestHandler"]>[0]
>;
type DisplayMediaRequest = NonNullable<
  Parameters<Electron.Session["setDisplayMediaRequestHandler"]>[0]
>;
const permissionHandlers = new Map<
  Electron.WebContents,
  { check: PermissionCheck; request: PermissionRequest; display: DisplayMediaRequest }
>();
const configuredSessions = new WeakSet<Electron.Session>();

/** Several project windows share origin cookies, but each keeps its own permission decisions. */
function configureCloudSession(browserSession: Electron.Session): void {
  if (configuredSessions.has(browserSession)) return;
  configuredSessions.add(browserSession);
  browserSession.setPermissionCheckHandler((contents, ...args) =>
    contents ? (permissionHandlers.get(contents)?.check(contents, ...args) ?? false) : false,
  );
  browserSession.setPermissionRequestHandler((contents, permission, callback, details) => {
    const handler = permissionHandlers.get(contents);
    if (handler) handler.request(contents, permission, callback, details);
    else callback(false);
  });
  browserSession.setDisplayMediaRequestHandler(
    (request, callback) => {
      const contents = request.frame ? webContents.fromFrame(request.frame) : undefined;
      const handler = contents ? permissionHandlers.get(contents) : undefined;
      if (handler) handler.display(request, callback);
      else callback({});
    },
    { useSystemPicker: false },
  );
}

const managedWindows = new Map<string, Set<BrowserWindow>>();

export async function closeManagedCloudWorkbench(partition: string): Promise<void> {
  const owned = managedWindows.get(partition);
  if (owned) for (const win of owned) if (!win.isDestroyed()) win.destroy();
  await session.fromPartition(partition).clearStorageData();
  managedWindows.delete(partition);
}

export async function openManagedCloudWorkbench(input: {
  grant: ManagedCloudGrant;
  projectId: string;
  authorized: () => boolean;
}): Promise<{ address: string }> {
  const { grant } = input;
  const origin = cloudOrigin(grant.session.audience);
  const projectId = cloudId(input.projectId);
  const partition = managedCloudPartition(grant);
  const current = () => {
    if (!cloudToken(grant.token) || grant.session.expiresAt <= Date.now() || !input.authorized())
      throw new Error("云端管理授权已失效，请重新连接。");
  };
  current();
  try {
    await session.fromPartition(partition).cookies.set({
      url: `${origin}/`,
      name: "cs_cloud_management",
      value: grant.token,
      path: "/",
      httpOnly: true,
      secure: true,
      sameSite: "strict",
      expirationDate: grant.session.expiresAt / 1000,
    });
    current();
    const result = await openWorkbench(`${origin}/`, {
      partition,
      address: `${origin}/?project=${projectId}`,
      current,
    });
    current();
    return result;
  } catch (error) {
    await closeManagedCloudWorkbench(partition);
    throw error;
  }
}

/** Remote workbenches get browser privileges only, with no Desktop preload or worker bridge. */
export async function openCloudWorkbench(rawAddress: unknown): Promise<{ address: string }> {
  return openWorkbench(rawAddress);
}
async function openWorkbench(
  rawAddress: unknown,
  managed?: { partition: string; address: string; current: () => void },
): Promise<{ address: string }> {
  const address = normalizeCloudWorkbenchAddress(rawAddress);
  managed?.current();
  const target = managed?.address ?? address;
  const key = managed?.partition ?? address;
  const existing = windows.get(key);
  if (existing && !existing.isDestroyed()) {
    if (managed && existing.webContents.getURL() !== target) {
      await existing.loadURL(target);
      managed.current();
    }
    existing.show();
    existing.focus();
    return { address: target };
  }
  const browserSession = session.fromPartition(
    managed?.partition ?? cloudWorkbenchPartition(address),
  );
  const title = `云端项目 · ${new URL(address).host}`;
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 390,
    minHeight: 540,
    title,
    show: false,
    webPreferences: {
      session: browserSession,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      webviewTag: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
    },
  });
  windows.set(key, win);
  if (managed) {
    const owned = managedWindows.get(managed.partition) ?? new Set<BrowserWindow>();
    owned.add(win);
    managedWindows.set(managed.partition, owned);
  }
  const cloudContents = win.webContents;
  const allowed = new Set<string>();
  let captureRevision = 0;
  const trustedRequest = (contents: Electron.WebContents | null, url: string): boolean =>
    !win.isDestroyed() &&
    contents === win.webContents &&
    isCloudWorkbenchOrigin(address, url) &&
    isCloudWorkbenchOrigin(address, contents.getURL());
  const check: PermissionCheck = (contents, permission, requestingOrigin, details) => {
    if (!trustedRequest(contents, details.securityOrigin ?? requestingOrigin)) return false;
    if (String(permission) === "display-capture") return details.isMainFrame === true;
    if (permission === "clipboard-sanitized-write" || permission === "fullscreen") return true;
    return permission === "media"
      ? allowed.has(`media:${details.mediaType}`)
      : allowed.has(permission);
  };
  const requestPermission: PermissionRequest = (contents, permission, callback, details) => {
    if (!trustedRequest(contents, details.requestingUrl)) return callback(false);
    if (String(permission) === "display-capture") return callback(details.isMainFrame === true);
    if (permission === "clipboard-sanitized-write" || permission === "fullscreen")
      return callback(true);
    const mediaTypes = "mediaTypes" in details ? (details.mediaTypes ?? []) : [];
    if (
      permission !== "notifications" &&
      (permission !== "media" ||
        mediaTypes.length === 0 ||
        !mediaTypes.every((type) => type === "audio" || type === "video"))
    )
      return callback(false);
    const requested =
      permission === "notifications"
        ? "发送任务通知"
        : mediaTypes.map((type) => (type === "audio" ? "使用麦克风" : "使用摄像头")).join("、");
    void (async () => {
      const result = await dialog.showMessageBox(win, {
        type: "question",
        title,
        message: `允许 ${new URL(address).host} ${requested}吗？`,
        buttons: ["不允许", "允许"],
        defaultId: 0,
        cancelId: 0,
      });
      if (result.response !== 1 || !trustedRequest(contents, details.requestingUrl)) return false;
      if (permission === "media" && process.platform === "darwin") {
        for (const type of mediaTypes)
          if (
            !(await systemPreferences.askForMediaAccess(type === "audio" ? "microphone" : "camera"))
          )
            return false;
      }
      if (!trustedRequest(contents, details.requestingUrl)) return false;
      if (permission === "media") for (const type of mediaTypes) allowed.add(`media:${type}`);
      else allowed.add(permission);
      return true;
    })().then(callback, () => callback(false));
  };
  const displayCapture = createCloudWorkbenchDisplayCapture({
    revision: () => captureRevision,
    isTrusted: (frame, origin) =>
      !win.isDestroyed() &&
      frame === win.webContents.mainFrame &&
      trustedRequest(win.webContents, frame.url) &&
      isCloudWorkbenchOrigin(address, origin),
    getSources: () =>
      desktopCapturer.getSources({
        types: ["screen", "window"],
        thumbnailSize: { width: 0, height: 0 },
      }),
    choose: async (sources, more) =>
      (
        await dialog.showMessageBox(win, {
          type: "question",
          title: "选择要录制的画面",
          message: "只录制你选择的屏幕或窗口",
          buttons: [
            "取消",
            ...sources.map((source) => source.name),
            ...(more ? ["查看更多窗口"] : []),
          ],
          defaultId: 0,
          cancelId: 0,
          noLink: true,
        })
      ).response,
    systemAudio: process.platform === "win32",
  });
  permissionHandlers.set(cloudContents, {
    check,
    request: requestPermission,
    display: (request, callback) => {
      void displayCapture(request, callback);
    },
  });
  configureCloudSession(browserSession);
  win.webContents.on("did-start-navigation", (_event, _url, _inPlace, mainFrame) => {
    if (mainFrame) captureRevision++;
  });
  win.on("page-title-updated", (event) => event.preventDefault());
  win.webContents.setWindowOpenHandler(({ url }) => {
    const launch =
      isCloudWorkbenchOrigin(address, win.webContents.getURL()) &&
      cloudWorkbenchBrowserHandoffUrl(address, url);
    if (launch)
      void shell.openExternal(launch).catch(() => {
        if (!win.isDestroyed())
          void dialog.showMessageBox(win, {
            type: "error",
            message: "无法打开系统浏览器，请重试授权。",
          });
      });
    return { action: "deny" };
  });
  const navigation = createCloudWorkbenchNavigation(address);
  win.webContents.on("will-navigate", (event, target) => {
    if (!navigation.allows(win.webContents.getURL(), target)) event.preventDefault();
  });
  win.webContents.on("will-redirect", (event, target, _inPlace, mainFrame) => {
    if (!navigation.allows(win.webContents.getURL(), target, mainFrame)) event.preventDefault();
  });
  win.webContents.on("did-navigate", (_event, target) => {
    navigation.committed(target);
    win.setTitle(
      isCloudWorkbenchOrigin(address, target) ? title : `Link 授权 · ${new URL(target).host}`,
    );
  });
  win.webContents.on("will-attach-webview", (event) => event.preventDefault());
  const download = (
    event: Electron.Event,
    item: Electron.DownloadItem,
    contents: Electron.WebContents,
  ): void => {
    if (contents !== win.webContents) return;
    if (
      !isCloudWorkbenchOrigin(address, item.getURL()) &&
      !item.getURL().startsWith(`blob:${new URL(address).origin}/`)
    ) {
      event.preventDefault();
      return;
    }
    item.setSaveDialogOptions({
      title: "保存云端项目文件",
      defaultPath: join(app.getPath("downloads"), basename(item.getFilename())),
    });
  };
  browserSession.on("will-download", download);
  win.once("closed", () => {
    captureRevision++;
    windows.delete(key);
    permissionHandlers.delete(cloudContents);
    if (managed) managedWindows.get(managed.partition)?.delete(win);
    allowed.clear();
    navigation.reset();
    browserSession.removeListener("will-download", download);
  });
  try {
    await win.loadURL(target);
    managed?.current();
    if (!win.isDestroyed()) {
      win.setTitle(title);
      win.show();
    }
  } catch {
    if (!win.isDestroyed()) win.destroy();
    throw new Error("无法打开云端项目，请检查地址和网络连接。");
  }
  return { address: target };
}
