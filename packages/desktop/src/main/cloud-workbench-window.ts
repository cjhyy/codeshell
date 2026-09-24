import { app, BrowserWindow, dialog, session, systemPreferences } from "electron";
import { basename, join } from "node:path";
import {
  cloudWorkbenchPartition,
  createCloudWorkbenchNavigation,
  isCloudWorkbenchOrigin,
  normalizeCloudWorkbenchAddress,
} from "./cloud-workbench-policy.js";

const windows = new Map<string, BrowserWindow>();

/** Remote workbenches get browser privileges only, with no Desktop preload or worker bridge. */
export async function openCloudWorkbench(rawAddress: unknown): Promise<{ address: string }> {
  const address = normalizeCloudWorkbenchAddress(rawAddress);
  const existing = windows.get(address);
  if (existing && !existing.isDestroyed()) {
    existing.show();
    existing.focus();
    return { address };
  }
  const browserSession = session.fromPartition(cloudWorkbenchPartition(address));
  const title = `云端工作台 · ${new URL(address).host}`;
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
  windows.set(address, win);
  const allowed = new Set<string>();
  const trustedRequest = (contents: Electron.WebContents | null, url: string): boolean =>
    !win.isDestroyed() &&
    contents === win.webContents &&
    isCloudWorkbenchOrigin(address, url) &&
    isCloudWorkbenchOrigin(address, contents.getURL());
  browserSession.setPermissionCheckHandler((contents, permission, requestingOrigin, details) => {
    if (!trustedRequest(contents, details.securityOrigin ?? requestingOrigin)) return false;
    if (permission === "clipboard-sanitized-write" || permission === "fullscreen") return true;
    return permission === "media"
      ? allowed.has(`media:${details.mediaType}`)
      : allowed.has(permission);
  });
  browserSession.setPermissionRequestHandler((contents, permission, callback, details) => {
    if (!trustedRequest(contents, details.requestingUrl)) return callback(false);
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
  });
  win.on("page-title-updated", (event) => event.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
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
    windows.delete(address);
    allowed.clear();
    navigation.reset();
    browserSession.removeListener("will-download", download);
  });
  try {
    await win.loadURL(address);
    if (!win.isDestroyed()) {
      win.setTitle(title);
      win.show();
    }
  } catch {
    if (!win.isDestroyed()) win.destroy();
    throw new Error("无法打开云端工作台，请检查地址和网络连接。");
  }
  return { address };
}
