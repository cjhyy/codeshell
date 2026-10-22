import { describe, expect, test } from "bun:test";
import type { IpcMain, IpcMainInvokeEvent } from "electron";
import { mainWindowTitleBarOptions, registerWindowTitleBarIpc } from "./window-titlebar";

function harness(platform: NodeJS.Platform = "win32") {
  const calls: unknown[][] = [[], []];
  const windows = calls.map((updates) => ({
    webContents: {
      mainFrame: {},
      zoom: 1,
      getZoomFactor() {
        return this.zoom;
      },
    },
    destroyed: false,
    isDestroyed() {
      return this.destroyed;
    },
    setTitleBarOverlay(value: unknown) {
      updates.push(value);
    },
  }));
  let listener: Parameters<IpcMain["handle"]>[1];
  registerWindowTitleBarIpc({
    platform,
    windows: () => windows as any,
    ipcMain: {
      handle(channel, callback) {
        expect(channel).toBe("window:titleBarOverlay");
        listener = callback;
      },
    },
  });
  const invoke = (
    input: unknown,
    sender = windows[0]!.webContents,
    senderFrame: object | null = sender.mainFrame,
  ) => listener({ sender, senderFrame } as IpcMainInvokeEvent, input);
  return { calls, windows, invoke };
}

describe("main window title bar", () => {
  test("Windows merges the title bar without replacing native caption buttons", () => {
    expect(mainWindowTitleBarOptions("win32", false)).toEqual({
      titleBarStyle: "hidden",
      titleBarOverlay: { color: "#00000000", symbolColor: "#262629", height: 44 },
    });
    expect(mainWindowTitleBarOptions("win32", true).titleBarOverlay).toMatchObject({
      symbolColor: "#eeeeee",
    });
    expect(mainWindowTitleBarOptions("darwin", true)).toEqual({ titleBarStyle: "hiddenInset" });
    expect(mainWindowTitleBarOptions("linux", true)).toEqual({ titleBarStyle: "default" });
  });

  test("updates only the requesting main window, keeps the header transparent, and deduplicates", () => {
    const { invoke, calls, windows } = harness();
    const appearance = { symbolColor: "#abcdef", height: 52, color: "#ffffff", other: true };
    invoke(appearance, windows[1]!.webContents);
    invoke(appearance, windows[1]!.webContents);
    expect(calls[0]).toEqual([]);
    expect(calls[1]).toEqual([{ color: "#00000000", symbolColor: "#abcdef", height: 52 }]);
    invoke({ symbolColor: "#ffffff", height: 44 }, windows[1]!.webContents);
    expect(calls[1]).toHaveLength(2);
  });

  test("rejects malformed colors and unbounded geometry before calling the native API", () => {
    const { invoke, calls } = harness();
    for (const value of [
      null,
      [],
      "dark",
      {},
      { symbolColor: "white", height: 44 },
      { symbolColor: "#ffffff00", height: 44 },
      { symbolColor: "#fff; display:none", height: 44 },
      { symbolColor: "#ffffff", height: "44" },
      { symbolColor: "#ffffff", height: 31 },
      { symbolColor: "#ffffff", height: 257 },
      { symbolColor: "#ffffff", height: 44.5 },
      { symbolColor: "#ffffff", height: NaN },
      { symbolColor: "#ffffff", height: Infinity },
    ]) {
      expect(() => invoke(value)).toThrow("Invalid window title bar appearance");
    }
    expect(calls[0]).toEqual([]);
    invoke({ symbolColor: "#AABBCC", height: 32 });
    invoke({ symbolColor: "#aabbcc", height: 256 });
    expect(calls[0]).toHaveLength(2);
  });

  test("rejects guests, popouts, missing frames and destroyed windows", () => {
    const { invoke, calls, windows } = harness();
    const appearance = { symbolColor: "#abcdef", height: 44 };
    expect(() => invoke(appearance, { ...windows[0]!.webContents, mainFrame: {} })).toThrow(
      "Only the main desktop window",
    );
    expect(() => invoke(appearance, windows[0]!.webContents, {})).toThrow(
      "Only the main desktop window",
    );
    expect(() => invoke(appearance, windows[0]!.webContents, null)).toThrow(
      "Only the main desktop window",
    );
    windows[0]!.destroyed = true;
    expect(() => invoke(appearance)).toThrow("Only the main desktop window");
    expect(calls).toEqual([[], []]);
  });

  test("does not call the Windows-only native API on other platforms", () => {
    for (const platform of ["darwin", "linux"] as const) {
      const { invoke, calls } = harness(platform);
      invoke({ symbolColor: "#abcdef", height: 44 });
      expect(calls).toEqual([[], []]);
    }
  });

  test("converts page zoom to native DIP and keeps native controls usable when zoomed out", () => {
    const { invoke, calls, windows } = harness();
    const sender = windows[0]!.webContents;
    const appearance = { symbolColor: "#abcdef", height: 44 };
    invoke(appearance);
    sender.zoom = 2;
    invoke(appearance);
    sender.zoom = 0.8;
    invoke(appearance);
    sender.zoom = 0.5;
    invoke({ ...appearance, height: 64 });
    expect(calls[0]).toEqual([
      { color: "#00000000", symbolColor: "#abcdef", height: 44 },
      { color: "#00000000", symbolColor: "#abcdef", height: 88 },
      { color: "#00000000", symbolColor: "#abcdef", height: 36 },
      { color: "#00000000", symbolColor: "#abcdef", height: 32 },
    ]);
    sender.zoom = 5;
    invoke({ ...appearance, height: 256 });
    expect(calls[0]!.at(-1)).toEqual({
      color: "#00000000",
      symbolColor: "#abcdef",
      height: 512,
    });
  });
});
