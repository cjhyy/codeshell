/**
 * BrowserHost — 浏览器载体底座(凭证登录窗口 / 后续全收编共用)。
 *
 * 统一「创建一个浏览器载体(BrowserWindow / webview)+ 公共配置 + 安全加固 + 生命周期 +
 * 读 cookie + 销毁分区」的底层逻辑,让上层各种「用浏览器干嘛」(登录抓 cookie、popout、自动化)
 * 都建在同一基座上,而不是各自散写 `new BrowserWindow` / `<webview>`。
 *
 * 设计见 docs/superpowers/specs/2026-06-17-browser-host-and-login-window-design.md。
 * 分两步全收编:**第一步只实现 `window` 形态**(登录窗口要用);`webview` 形态 + 收编现有
 * 主窗/popout/BrowserPanel 留到第二步,接口已预留。
 *
 * desktop main 私有(强依赖 Electron,不进 core)。Electron 经 lazy import,使纯 helper 可单测。
 */

import type { ElectronCookieLike } from "../credentials-service.js";

export interface BrowserHostOpenOptions {
  /** 载体形态。第一步只支持 'window'(独立 BrowserWindow)。 */
  kind: "window";
  /** 初始加载的 URL(外部站点,如登录页)。 */
  url: string;
  /** session 分区(如 persist:login-<id>);决定 cookie 隔离。 */
  partition: string;
  width?: number;
  height?: number;
  title?: string;
  /** 覆盖 UA(伪装桌面 Chrome 等);省略用默认。 */
  userAgent?: string;
  onFailLoad?: (info: { errorCode: number; errorDescription: string; url: string }) => void;
  onRenderGone?: (info: { reason: string }) => void;
}

export interface BrowserHostHandle {
  readonly webContents: Electron.WebContents;
  loadURL(url: string): Promise<void>;
  executeJavaScript<T = unknown>(code: string): Promise<T>;
  /** 读该 handle 分区的 cookie(可按域过滤,Electron 后缀匹配)。 */
  getCookies(domain?: string): Promise<ElectronCookieLike[]>;
  /** 关闭窗口(不销毁分区;分区销毁用 destroyPartition)。 */
  close(): void;
  /** 注册关闭回调。 */
  onClosed(cb: () => void): void;
}

/**
 * 纯 helper:为外部站点登录窗口构造 BrowserWindow 选项 + webPreferences。
 * 不注入我们的 preload(外部站点不该拿到我们的 API);加固 contextIsolation/sandbox。
 * 抽出来是为了可单测(不碰 Electron)。
 */
export function buildWindowOptions(opts: BrowserHostOpenOptions): {
  width: number;
  height: number;
  title: string;
  autoHideMenuBar: true;
  backgroundColor: string;
  webPreferences: {
    partition: string;
    nodeIntegration: false;
    contextIsolation: true;
    sandbox: true;
    webSecurity: true;
  };
} {
  return {
    width: opts.width ?? 1000,
    height: opts.height ?? 720,
    title: opts.title ?? "登录",
    autoHideMenuBar: true,
    backgroundColor: "#ffffff",
    webPreferences: {
      partition: opts.partition,
      // 外部站点:无 preload、全加固。
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
    },
  };
}

/** 非 http(s)/about 的导航一律拦掉(防外链跳到本地协议等)。纯函数,可单测。 */
export function shouldBlockNavigation(url: string): boolean {
  return !/^(https?|about):/i.test(url);
}

/**
 * 打开一个浏览器载体(window 形态)。返回 handle。
 * 加载外部 URL,装好防外链 / 失败兜底,暴露读 cookie / 执行脚本 / 关闭。
 */
export async function openBrowserHost(opts: BrowserHostOpenOptions): Promise<BrowserHostHandle> {
  if (opts.kind !== "window") {
    throw new Error(`BrowserHost: kind '${opts.kind}' not implemented yet (第一步只支持 window)`);
  }
  const { BrowserWindow, session } = await import("electron");
  const win = new BrowserWindow(buildWindowOptions(opts) as Electron.BrowserWindowConstructorOptions);

  // 防外链:非 http(s)/about 的导航拦掉;任何 window.open / target=_blank 一律 deny
  // (登录窗口不需要弹新窗)。
  win.webContents.on("will-navigate", (ev, url) => {
    if (shouldBlockNavigation(url)) ev.preventDefault();
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    // 登录流程里偶有跳第三方授权页用 window.open;允许导航在本窗发生,但不开新 OS 窗。
    // loadURL 不触发 will-navigate,这里得自己走同一道防外链门(否则 window.open 能把顶层
    // 导到任意站点,绕过 shouldBlockNavigation)。ERR_ABORTED(被后续导航打断)吞掉。
    if (!shouldBlockNavigation(url) && !win.isDestroyed()) {
      win.loadURL(url).catch(() => {});
    }
    return { action: "deny" };
  });

  if (opts.onFailLoad) {
    win.webContents.on("did-fail-load", (_e, errorCode, errorDescription, validatedURL) => {
      opts.onFailLoad?.({ errorCode, errorDescription, url: validatedURL });
    });
  }
  if (opts.onRenderGone) {
    win.webContents.on("render-process-gone", (_e, details) => {
      opts.onRenderGone?.({ reason: details.reason });
    });
  }

  if (opts.userAgent) win.webContents.setUserAgent(opts.userAgent);
  // 不能裸 await:登录页常在初始导航里就客户端重定向(location.href / meta-refresh),
  // 会让 loadURL 以 ERR_ABORTED reject。这属正常,吞掉别让 openBrowserHost 抛错关窗;
  // 真正的加载失败由 did-fail-load(onFailLoad)上报。
  await win.loadURL(opts.url).catch((e: unknown) => {
    const msg = String((e as { message?: unknown })?.message ?? e);
    if (!/ERR_ABORTED|-3\b/.test(msg)) throw e;
  });

  const sess = session.fromPartition(opts.partition);
  return {
    webContents: win.webContents,
    loadURL: (url) => win.loadURL(url),
    executeJavaScript: <T,>(code: string) => win.webContents.executeJavaScript(code) as Promise<T>,
    getCookies: async (domain?: string) =>
      (await sess.cookies.get(domain ? { domain } : {})) as ElectronCookieLike[],
    close: () => {
      if (!win.isDestroyed()) win.close();
    },
    onClosed: (cb) => win.on("closed", cb),
  };
}

/**
 * 销毁一个分区的 cookie(登完即焚 = 无痕)。best-effort。
 * 仅清 cookie(本期不动 localStorage,见设计稿已知局限)。
 */
export async function destroyPartitionCookies(partition: string): Promise<void> {
  try {
    const { session } = await import("electron");
    await session.fromPartition(partition).clearStorageData({ storages: ["cookies"] });
  } catch {
    /* best-effort */
  }
}
