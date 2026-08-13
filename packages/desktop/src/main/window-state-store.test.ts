import { afterEach, describe, test, expect } from "bun:test";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  __setWindowStateFileForTest,
  loadWindowState,
  sanitizeWindowState,
  saveWindowState,
} from "./window-state-store.js";

const roots: string[] = [];

afterEach(async () => {
  __setWindowStateFileForTest(null);
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

// Regression: loadWindowState spread the parsed file over DEFAULT with no
// validation, so a corrupt window.json (NaN/negative/wrong-typed dims) flowed
// straight into BrowserWindow (review-2026-05-30).

describe("sanitizeWindowState", () => {
  test("keeps valid values", () => {
    expect(sanitizeWindowState({ width: 1000, height: 700, x: 10, y: 20, maximized: true })).toEqual({
      width: 1000,
      height: 700,
      x: 10,
      y: 20,
      maximized: true,
    });
  });

  test("falls back to defaults for non-numeric / NaN / out-of-range dims", () => {
    expect(sanitizeWindowState({ width: "big", height: NaN })).toEqual({ width: 1180, height: 800 });
    expect(sanitizeWindowState({ width: -5, height: 999999 })).toEqual({ width: 1180, height: 800 });
  });

  test("drops invalid optional fields", () => {
    const s = sanitizeWindowState({ width: 1000, height: 700, x: "left", maximized: "yes" });
    expect(s).toEqual({ width: 1000, height: 700 });
  });

  test("handles non-object input", () => {
    expect(sanitizeWindowState(null)).toEqual({ width: 1180, height: 800 });
    expect(sanitizeWindowState("garbage")).toEqual({ width: 1180, height: 800 });
  });
});

describe("window-state persistence", () => {
  test("serializes rapid snapshots and leaves one private valid JSON file", async () => {
    const root = await mkdtemp(join(tmpdir(), "codeshell-window-state-"));
    roots.push(root);
    const file = join(root, "desktop", "window.json");
    __setWindowStateFileForTest(file);

    await Promise.all(
      Array.from({ length: 30 }, (_, index) =>
        saveWindowState({ width: 1_000 + index, height: 700 + index }),
      ),
    );
    expect(await loadWindowState()).toEqual({ width: 1_029, height: 729 });
    const raw = await readFile(file, "utf8");
    expect(() => JSON.parse(raw)).not.toThrow();
    expect((await readdir(join(root, "desktop"))).some((name) => name.endsWith(".tmp"))).toBe(
      false,
    );
    if (process.platform !== "win32") expect((await stat(file)).mode & 0o777).toBe(0o600);
  });
});
