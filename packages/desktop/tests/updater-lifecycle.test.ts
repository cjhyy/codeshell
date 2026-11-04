// Electron and updater mocks must stay isolated from other desktop suites.
import { expect, mock, spyOn, test } from "bun:test";
import { EventEmitter } from "node:events";
import * as childProcess from "node:child_process";

const testIsolated = process.env.CODESHELL_UPDATER_FIXTURE === "1" ? test : test.skip;

testIsolated("async signature probes cannot overwrite newer updater states", async () => {
  const events = new EventEmitter();
  const appEvents = new EventEmitter();
  const callbacks: Array<(error: null, stdout: string, stderr: string) => void> = [];
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  const resources = Object.getOwnPropertyDescriptor(process, "resourcesPath");
  const previousForce = process.env.CODESHELL_FORCE_MAC_AUTO_UPDATE;
  delete process.env.CODESHELL_FORCE_MAC_AUTO_UPDATE;
  Object.defineProperty(process, "platform", { value: "darwin" });
  Object.defineProperty(process, "resourcesPath", {
    value: "/tmp/codeshell-updater-fixture",
    configurable: true,
  });
  const exec = spyOn(childProcess, "execFile").mockImplementation((...args: any[]) => {
    callbacks.push(args.at(-1));
    return {} as any;
  });
  mock.module("electron", () => ({
    BrowserWindow: { getAllWindows: () => [] },
    app: Object.assign(appEvents, {
      isPackaged: true,
      getVersion: () => "1.0.0",
      getAppPath: () => "/Applications/CodeShell.app/Contents/Resources/app.asar",
      getPath: () => "/tmp/codeshell-updater-fixture/downloads",
    }),
  }));
  mock.module("electron-updater", () => ({
    autoUpdater: Object.assign(events, { setFeedURL: () => {} }),
  }));
  mock.module("../src/main/desktop-logger.js", () => ({ dlog: () => {} }));
  try {
    const updater = await import("../src/main/updater.js");
    updater.initUpdater();
    events.emit("update-available", { version: "2.0.0" });
    expect(callbacks).toHaveLength(2);
    events.emit("error", new Error("newer update check failed"));
    for (const done of callbacks) done(null, "", "");
    await new Promise((resolve) => setImmediate(resolve));
    expect(updater.getLastStatus()).toMatchObject({
      kind: "error",
      message: "newer update check failed",
    });

    events.emit("update-available", { version: "3.0.0" });
    events.emit("checking-for-update");
    await new Promise((resolve) => setImmediate(resolve));
    expect(updater.getLastStatus()).toEqual({ kind: "checking" });

    events.emit("update-available", { version: "4.0.0" });
    events.emit("update-not-available", { version: "5.0.0" });
    await new Promise((resolve) => setImmediate(resolve));
    expect(updater.getLastStatus()).toEqual({ kind: "not-available", version: "5.0.0" });

    events.emit("update-available", { version: "6.0.0" });
    await new Promise((resolve) => setImmediate(resolve));
    expect(updater.getLastStatus()).toEqual({ kind: "available", version: "6.0.0" });
  } finally {
    appEvents.emit("before-quit");
    exec.mockRestore();
    Object.defineProperty(process, "platform", platform);
    if (resources) Object.defineProperty(process, "resourcesPath", resources);
    else delete (process as any).resourcesPath;
    if (previousForce === undefined) delete process.env.CODESHELL_FORCE_MAC_AUTO_UPDATE;
    else process.env.CODESHELL_FORCE_MAC_AUTO_UPDATE = previousForce;
  }
});
