import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  PET_WIDGET_EXPANDED_HEIGHT,
  PET_WIDGET_EXPANDED_WIDTH,
  clampPetWidgetWindowPosition,
  defaultPetWidgetWindowPosition,
  petWidgetWindowStatePath,
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

  test("deduplicates concurrent renderer requests into one Pet BrowserWindow", () => {
    const mainSource = readFileSync(join(import.meta.dir, "..", "index.ts"), "utf8");
    expect(mainSource).toContain("let petWidgetWindowCreation: Promise<BrowserWindow> | null");
    expect(mainSource).toContain("if (petWidgetWindowCreation) return petWidgetWindowCreation");
  });

  test("starts hidden and exposes process-scoped visibility without creating a window", () => {
    const mainSource = readFileSync(join(import.meta.dir, "..", "index.ts"), "utf8");
    expect(mainSource).toContain("let petWidgetShouldBeVisible = false");
    expect(mainSource).toContain('ipcMain.handle("pet:widget-visible-get"');
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
