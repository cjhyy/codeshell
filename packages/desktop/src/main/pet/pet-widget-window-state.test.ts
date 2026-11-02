import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  PET_WIDGET_EXPANDED_HEIGHT,
  PET_WIDGET_EXPANDED_WIDTH,
  clampPetWidgetWindowPosition,
  defaultPetWidgetWindowPosition,
  petWidgetAlwaysOnTopLevel,
  petWidgetWindowStatePath,
  petWidgetSurface,
  sanitizePetWidgetWindowPosition,
  shouldSkipPetWidgetTaskbar,
} from "./pet-widget-window-state";

describe("desktop Pet window position", () => {
  const workArea = { x: -1_440, y: 0, width: 1_440, height: 900 };

  test("keeps a desktop pet inside the selected display work area", () => {
    expect(clampPetWidgetWindowPosition({ x: -2_000, y: 1_000 }, workArea)).toEqual({
      x: -1_428,
      y: 776,
    });
  });

  test("places a new pet near the work area's bottom-right corner", () => {
    expect(defaultPetWidgetWindowPosition(workArea)).toEqual({ x: -136, y: 764 });
  });

  test("keeps the whole chat bubble visible while preserving a pet anchor", () => {
    expect(
      clampPetWidgetWindowPosition({ x: -1_400, y: 30 }, workArea, {
        width: PET_WIDGET_EXPANDED_WIDTH,
        height: PET_WIDGET_EXPANDED_HEIGHT,
      }),
    ).toEqual({ x: -1_140, y: 280 });
  });

  test("uses a compact default surface and only expands for requested content", () => {
    expect(petWidgetSurface("collapsed")).toEqual({ width: 112, height: 112 });
    expect(petWidgetSurface("expanded")).toEqual({
      width: PET_WIDGET_EXPANDED_WIDTH,
      height: PET_WIDGET_EXPANDED_HEIGHT,
    });
  });

  test("rejects malformed persisted coordinates", () => {
    expect(sanitizePetWidgetWindowPosition({ x: 12.4, y: 33.6 })).toEqual({ x: 12, y: 34 });
    expect(sanitizePetWidgetWindowPosition({ x: "left", y: 20 })).toBeNull();
    expect(sanitizePetWidgetWindowPosition(null)).toBeNull();
  });

  test("does not hide the whole application from the macOS Dock", () => {
    expect(shouldSkipPetWidgetTaskbar("darwin")).toBe(false);
    expect(shouldSkipPetWidgetTaskbar("win32")).toBe(true);
    expect(shouldSkipPetWidgetTaskbar("linux")).toBe(true);
  });

  test("uses a system overlay level for the macOS pet", () => {
    expect(petWidgetAlwaysOnTopLevel("darwin")).toBe("screen-saver");
    expect(petWidgetAlwaysOnTopLevel("win32")).toBe("floating");
    expect(petWidgetAlwaysOnTopLevel("linux")).toBe("floating");
  });

  test("keeps the pet above other apps and active across macOS Spaces", () => {
    const mainSource = readFileSync(join(import.meta.dir, "..", "index.ts"), "utf8");
    // Window lifecycle moved into the docked surface; host-specific options stay in index.ts.
    const surfaceSource = readFileSync(join(import.meta.dir, "pet-widget-surface.ts"), "utf8");
    expect(surfaceSource).toContain(
      "win.setAlwaysOnTop(true, petWidgetAlwaysOnTopLevel(options.platform))",
    );
    expect(surfaceSource).toContain("win.moveTop()");
    const factory = mainSource.slice(
      mainSource.indexOf("function createPetWidgetBrowserWindow("),
      mainSource.indexOf("async function loadPetWidgetBrowserWindow("),
    );
    // A regular NSWindow is not drawn over another app's fullscreen Space: on a
    // display showing one, the docked pet was off screen (2026-11-02 three-display
    // acceptance). The macOS widget is a non-activating panel like the moving form,
    // and joins those Spaces without the process-type (Dock) round trip.
    expect(factory).toContain(
      '...(process.platform === "darwin" ? { type: "panel" as const } : {})',
    );
    expect(factory).toMatch(
      /win\.setVisibleOnAllWorkspaces\(true, \{\s*visibleOnFullScreen: true,\s*skipTransformProcessType: true,?\s*\}\)/,
    );
    expect(mainSource).toContain("win.setHiddenInMissionControl(true)");
    expect(mainSource).toContain("backgroundThrottling: false");
    expect(surfaceSource).toContain('win.on("always-on-top-changed"');
  });

  test("deduplicates concurrent renderer requests into one Pet BrowserWindow", () => {
    const surfaceSource = readFileSync(join(import.meta.dir, "pet-widget-surface.ts"), "utf8");
    expect(surfaceSource).toContain("let creation: Promise<PetWidgetWindowLike> | null");
    expect(surfaceSource).toContain("if (creation) return creation");
  });

  test("starts hidden and exposes visibility through the single presence owner", () => {
    const mainSource = readFileSync(join(import.meta.dir, "..", "index.ts"), "utf8");
    const stateSource = readFileSync(join(import.meta.dir, "mimi-presence-state.ts"), "utf8");
    const ipcSource = readFileSync(join(import.meta.dir, "mimi-presence-ipc.ts"), "utf8");
    expect(stateSource).toContain('visible: false, mode: "docked"');
    expect(ipcSource).toContain('deps.ipcMain.handle("pet:widget-visible-get"');
    expect(mainSource).toContain("registerMimiPresenceIpc({");
    // No second, independent visibility flag for the widget remains in main.
    expect(mainSource).not.toContain("petWidgetShouldBeVisible");
  });

  test("keeps double-click open separate from the native right-click close action", () => {
    const widgetSource = readFileSync(
      join(import.meta.dir, "..", "..", "renderer", "pet", "PetWidget.tsx"),
      "utf8",
    );
    const mainSource = readFileSync(join(import.meta.dir, "..", "index.ts"), "utf8");
    expect(widgetSource).toContain("onDoubleClick");
    expect(widgetSource).toContain("onOpen();");
    expect(widgetSource).toContain("onContextMenu();");
    expect(widgetSource).not.toContain("onClose();");
    expect(mainSource).toContain('ipcMain.on("pet:widget-context-menu"');
    expect(mainSource).toContain("event.sender !== win.webContents");
    expect(mainSource).toContain('chinese ? "关闭 Mimi" : "Close Mimi"');
    expect(mainSource).toContain("mimiPresenceOwner.set({ visible: false })");
  });

  test("serializes position saves and uses atomic temporary-file replacement", () => {
    const source = readFileSync(join(import.meta.dir, "pet-widget-window-state.ts"), "utf8");
    expect(source).toContain("let positionWriteQueue = Promise.resolve()");
    expect(source).toContain('flag: "wx"');
    expect(source).toContain("await fs.rename(temporary, file)");
  });

  test("stores widget state under the configured CodeShell home", () => {
    const previous = process.env.CODE_SHELL_HOME;
    process.env.CODE_SHELL_HOME = "/tmp/codeshell-widget-home";
    try {
      expect(petWidgetWindowStatePath()).toBe("/tmp/codeshell-widget-home/desktop/pet-widget.json");
    } finally {
      if (previous === undefined) delete process.env.CODE_SHELL_HOME;
      else process.env.CODE_SHELL_HOME = previous;
    }
  });
});
