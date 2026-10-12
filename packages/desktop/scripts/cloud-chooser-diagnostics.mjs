// Test-only observations: never retain URLs, payloads, credentials or raw errors.
export function describeCloudChooserLocation(value, cloudOrigin) {
  try {
    if (!value) return { target: "empty" };
    const url = new URL(value);
    if (url.origin !== cloudOrigin) return { target: "other" };
    return {
      target: "cloud",
      rootPath: url.pathname === "/",
      projectOnlyQuery:
        url.searchParams.size === 1 &&
        /^[0-9a-f-]{36}$/.test(url.searchParams.get("project") ?? ""),
      fragment: !!url.hash,
      userInfo: !!(url.username || url.password),
    };
  } catch {
    return { target: "invalid" };
  }
}

export function describeCloudChooserError(value) {
  const message =
    typeof value === "string"
      ? value
      : value instanceof Error && typeof value.message === "string"
        ? value.message
        : "";
  for (const [text, category] of [
    ["无法打开云端项目，请检查地址和网络连接。", "window-load-failed"],
    ["云端管理授权已失效，请重新连接。", "grant-invalid"],
    ["云端项目入口无效。", "project-entry-invalid"],
    ["云端返回了其他项目，请重新加载。", "project-mismatch"],
    ["云端安装身份已变化，请重新连接。", "installation-changed"],
  ])
    if (message.includes(text)) return category;
  return value instanceof Error || typeof value === "string" ? "other-error" : "non-error";
}

export function describeCloudChooserAlerts(values) {
  return {
    count: Math.min(values.length, 100),
    categories: values.slice(0, 4).map(describeCloudChooserError),
  };
}

/** Wrap registration, preserving the actual handler's result/throw and its receiver. */
export function installCloudChooserDiagnostics({ app, ipcMain, cloudOrigin }) {
  const ipc = { started: 0, settled: 0, failed: 0 };
  const windows = [];
  const handle = ipcMain.handle;
  ipcMain.handle = function (channel, listener) {
    if (channel !== "cloud:open-workbench") return handle.call(this, channel, listener);
    return handle.call(this, channel, async function (event, ...args) {
      if (args[0]?.action !== "open") return listener.call(this, event, ...args);
      ipc.started++;
      ipc.state = "pending";
      delete ipc.result;
      delete ipc.error;
      try {
        const result = await listener.call(this, event, ...args);
        ipc.settled++;
        ipc.state = "resolved";
        ipc.result = result?.action === "open" ? "open" : "unexpected";
        return result;
      } catch (error) {
        ipc.settled++;
        ipc.failed++;
        ipc.state = "rejected";
        ipc.error = describeCloudChooserError(error);
        throw error;
      }
    });
  };
  app.on("browser-window-created", (_event, win) => {
    if (windows.length >= 4) return;
    const prefs = win.webContents.getLastWebPreferences();
    const record = {
      kind: prefs.preload ? "preloaded" : "browser",
      events: [],
      closed: false,
      finished: false,
    };
    const observe = (name, details = {}) => {
      if (record.events.length < 12) record.events.push({ name, ...details });
    };
    win.webContents.on("did-start-navigation", (_event, url, _inPlace, mainFrame) => {
      if (mainFrame) observe("navigation", describeCloudChooserLocation(url, cloudOrigin));
    });
    win.webContents.on("did-fail-load", (_event, code, _description, url, mainFrame) => {
      if (mainFrame)
        observe("load-failed", {
          code: Number.isSafeInteger(code) ? code : null,
          ...describeCloudChooserLocation(url, cloudOrigin),
        });
    });
    win.webContents.on("did-finish-load", () => {
      record.finished = true;
      observe("load-finished");
    });
    win.webContents.on("did-stop-loading", () => observe("loading-stopped"));
    win.once("closed", () => {
      record.closed = true;
      observe("closed");
    });
    windows.push({ win, record });
  });
  return {
    snapshot() {
      return {
        ipc: { ...ipc },
        windows: windows.map(({ win, record }) => {
          const closed = record.closed || win.isDestroyed();
          return {
            ...record,
            closed,
            ...(closed
              ? {}
              : {
                  visible: win.isVisible(),
                  loading: win.webContents.isLoadingMainFrame(),
                  location: describeCloudChooserLocation(win.webContents.getURL(), cloudOrigin),
                }),
            events: record.events.map((event) => ({ ...event })),
          };
        }),
      };
    },
  };
}
