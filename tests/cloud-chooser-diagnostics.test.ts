import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import {
  describeCloudChooserAlerts,
  describeCloudChooserLocation,
  installCloudChooserDiagnostics,
} from "../packages/desktop/scripts/cloud-chooser-diagnostics.mjs";

const origin = "https://127.0.0.1:12345";
const project = "ecb22c84-2dbf-4fc4-b5e3-d741ade98d54";

function fixture() {
  const app = new EventEmitter();
  const handlers = new Map();
  const ipcMain = {
    handle(channel, listener) {
      expect(this).toBe(ipcMain);
      handlers.set(channel, listener);
    },
  };
  const diagnostics = installCloudChooserDiagnostics({ app, ipcMain, cloudOrigin: origin });
  return { app, handlers, ipcMain, diagnostics };
}

test("open diagnostics preserve real pending, result, receiver and rejection", async () => {
  const { handlers, ipcMain, diagnostics } = fixture();
  const receiver = {};
  const event = {};
  const result = { action: "open", address: `${origin}/?token=secret-result`, private: "secret" };
  const failure = new Error("secret-credential https://evil.invalid/?token=secret-error");
  let resolve;
  ipcMain.handle("cloud:open-workbench", function (received, request) {
    expect(this).toBe(receiver);
    expect(received).toBe(event);
    if (request.action === "list") return result;
    if (request.fail === "null") throw null;
    if (request.fail) throw failure;
    return new Promise((done) => (resolve = done));
  });
  const handler = handlers.get("cloud:open-workbench");
  expect(await handler.call(receiver, event, { action: "list" })).toBe(result);
  expect(diagnostics.snapshot().ipc).toEqual({ started: 0, settled: 0, failed: 0 });
  const pending = handler.call(receiver, event, { action: "open", token: "secret-input" });
  expect(diagnostics.snapshot().ipc).toEqual({
    started: 1,
    settled: 0,
    failed: 0,
    state: "pending",
  });
  resolve(result);
  expect(await pending).toBe(result);
  expect(diagnostics.snapshot().ipc).toEqual({
    started: 1,
    settled: 1,
    failed: 0,
    state: "resolved",
    result: "open",
  });
  await expect(handler.call(receiver, event, { action: "open", fail: true })).rejects.toBe(failure);
  expect(diagnostics.snapshot().ipc).toEqual({
    started: 2,
    settled: 2,
    failed: 1,
    state: "rejected",
    error: "other-error",
  });
  await expect(handler.call(receiver, event, { action: "open", fail: "null" })).rejects.toBe(null);
  expect(diagnostics.snapshot().ipc).toEqual({
    started: 3,
    settled: 3,
    failed: 2,
    state: "rejected",
    error: "non-error",
  });
  const unrelated = () => result;
  ipcMain.handle("unrelated", unrelated);
  expect(handlers.get("unrelated")).toBe(unrelated);
  expect(JSON.stringify(diagnostics.snapshot())).not.toMatch(/secret|token|evil|12345/);
});

test("load observation distinguishes pending and failed windows without URLs or error text", () => {
  const { app, diagnostics } = fixture();
  const win = new EventEmitter();
  const contents = new EventEmitter();
  Object.assign(contents, {
    getLastWebPreferences: () => ({ preload: "", sandbox: true }),
    getURL: () => `${origin}/?project=${project}&token=secret-url#secret-fragment`,
    isLoadingMainFrame: () => true,
  });
  Object.assign(win, {
    webContents: contents,
    isDestroyed: () => false,
    isVisible: () => false,
  });
  app.emit("browser-window-created", {}, win);
  contents.emit("did-start-navigation", {}, `${origin}/?project=${project}`, false, true);
  contents.emit("did-fail-load", {}, -202, "secret-error-message", `${origin}/?token=secret`, true);
  contents.emit("did-fail-load", {}, -999, "secret-subframe", "https://evil.invalid/", false);
  const [row] = diagnostics.snapshot().windows;
  expect(row.closed).toBe(false);
  expect(row.loading).toBe(true);
  expect(row.finished).toBe(false);
  expect(row.location).toEqual({
    target: "cloud",
    rootPath: true,
    projectOnlyQuery: false,
    fragment: true,
    userInfo: false,
  });
  expect(row.events).toEqual([
    {
      name: "navigation",
      target: "cloud",
      rootPath: true,
      projectOnlyQuery: true,
      fragment: false,
      userInfo: false,
    },
    {
      name: "load-failed",
      code: -202,
      target: "cloud",
      rootPath: true,
      projectOnlyQuery: false,
      fragment: false,
      userInfo: false,
    },
  ]);
  contents.emit("did-finish-load");
  win.emit("closed");
  expect(diagnostics.snapshot().windows[0]).toMatchObject({ closed: true, finished: true });
  expect(diagnostics.snapshot().windows[0]).not.toHaveProperty("location");
  expect(JSON.stringify(diagnostics.snapshot())).not.toMatch(/secret|token|evil|12345|ecb22c84/);
});

test("failure projections are bounded and unknown alerts cannot expose credentials", () => {
  expect(describeCloudChooserLocation("", origin)).toEqual({ target: "empty" });
  expect(describeCloudChooserLocation("invalid", origin)).toEqual({ target: "invalid" });
  expect(describeCloudChooserLocation("https://evil.invalid/?token=secret", origin)).toEqual({
    target: "other",
  });
  expect(
    describeCloudChooserAlerts([
      "Error invoking remote method 'cloud:open-workbench': Error: 无法打开云端项目，请检查地址和网络连接。",
      "secret-root-token https://evil.invalid/?ticket=secret",
      "云端管理授权已失效，请重新连接。",
      "secret-session",
      "another-secret",
    ]),
  ).toEqual({
    count: 5,
    categories: ["window-load-failed", "other-error", "grant-invalid", "other-error"],
  });
  const { app, diagnostics } = fixture();
  for (let index = 0; index < 10; index++) {
    const contents = Object.assign(new EventEmitter(), {
      getLastWebPreferences: () => ({ preload: "/secret/preload.js" }),
      getURL: () => "file:///secret/home/index.html",
      isLoadingMainFrame: () => false,
    });
    const win = Object.assign(new EventEmitter(), {
      webContents: contents,
      isDestroyed: () => false,
      isVisible: () => true,
    });
    app.emit("browser-window-created", {}, win);
    for (let event = 0; event < 100; event++) contents.emit("did-stop-loading");
  }
  const value = diagnostics.snapshot();
  expect(value.windows).toHaveLength(4);
  expect(value.windows.every((window) => window.events.length === 12)).toBe(true);
  expect(JSON.stringify(value)).not.toMatch(/secret|preload.js|file:/);
});
