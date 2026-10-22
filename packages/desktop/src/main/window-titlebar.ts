import type { BrowserWindow, BrowserWindowConstructorOptions, IpcMain } from "electron";
import type { WindowTitleBarOverlay } from "../shared/window-titlebar";

/** Keep native caption buttons while the renderer paints the Windows title bar. */
export function mainWindowTitleBarOptions(
  platform: NodeJS.Platform,
  dark: boolean,
): Pick<BrowserWindowConstructorOptions, "titleBarStyle" | "titleBarOverlay"> {
  if (platform === "darwin") return { titleBarStyle: "hiddenInset" };
  if (platform !== "win32") return { titleBarStyle: "default" };
  return {
    titleBarStyle: "hidden",
    titleBarOverlay: {
      color: "#00000000",
      symbolColor: dark ? "#eeeeee" : "#262629",
      height: 44,
    },
  };
}

function parseOverlay(input: unknown): WindowTitleBarOverlay {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("Invalid window title bar appearance");
  }
  const { symbolColor, height } = input as Record<string, unknown>;
  if (
    typeof symbolColor !== "string" ||
    !/^#[a-f\d]{6}$/i.test(symbolColor) ||
    typeof height !== "number" ||
    !Number.isInteger(height) ||
    height < 32 ||
    height > 256
  ) {
    throw new TypeError("Invalid window title bar appearance");
  }
  return { symbolColor, height };
}

type TitleBarWindow = Pick<BrowserWindow, "isDestroyed" | "webContents" | "setTitleBarOverlay">;

export function registerWindowTitleBarIpc(options: {
  ipcMain: Pick<IpcMain, "handle">;
  platform: NodeJS.Platform;
  windows: () => Iterable<TitleBarWindow>;
}): void {
  const previous = new WeakMap<TitleBarWindow, string>();
  options.ipcMain.handle("window:titleBarOverlay", (event, input: unknown) => {
    if (options.platform !== "win32") return;
    // Browser/Pet popouts and Panel guests do not own this main-window overlay.
    const window = [...options.windows()].find(
      (candidate) => !candidate.isDestroyed() && candidate.webContents === event.sender,
    );
    if (!window || !event.senderFrame || event.senderFrame !== event.sender.mainFrame) {
      throw new Error("Only the main desktop window can update its title bar");
    }
    const overlay = parseOverlay(input);
    // DOM geometry is in CSS pixels; native caption-button bounds use DIP.
    // Page zoom is independent of the display's scale factor.
    const nativeHeight = Math.min(
      512,
      Math.max(32, Math.ceil(overlay.height * event.sender.getZoomFactor())),
    );
    const key = `${overlay.symbolColor}:${nativeHeight}`;
    if (previous.get(window) === key) return;
    window.setTitleBarOverlay({
      color: "#00000000",
      symbolColor: overlay.symbolColor,
      height: nativeHeight,
    });
    previous.set(window, key);
  });
}
