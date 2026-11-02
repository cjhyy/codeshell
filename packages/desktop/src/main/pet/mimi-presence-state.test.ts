import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  createMimiPresenceWriter,
  defaultMimiPresenceState,
  dockedAnchorForFeet,
  dockedFeet,
  loadMimiPresenceState,
  migrateLegacyCompanionSize,
  migrateLegacyMimiPresence,
  movingAnchorForFeet,
  movingFeet,
  parseMimiPresenceState,
} from "./mimi-presence-state";
import { companionFeetOffset } from "../../shared/mimi-companion";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** Isolated fixture directories; never the operator's real configuration. */
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "mimi-presence-"));
  roots.push(root);
  return {
    root,
    paths: {
      statePath: join(root, "home", "desktop", "mimi-presence.json"),
      legacyCompanionPath: join(root, "user-data", "mimi-companion.json"),
      legacyWidgetPath: join(root, "home", "desktop", "pet-widget.json"),
    },
  };
}

async function put(file: string, text: string) {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, text);
}

describe("defaults and sizes", () => {
  test("first launch is hidden, docked and uses the 200 DIP default", () => {
    expect(defaultMimiPresenceState()).toEqual({
      schemaVersion: 1,
      visible: false,
      mode: "docked",
      size: 200,
    });
  });

  test("legacy 320 (the old default) migrates to 200; other valid choices are kept or clamped", () => {
    expect(migrateLegacyCompanionSize(320)).toBe(200);
    expect(migrateLegacyCompanionSize(240)).toBe(240);
    expect(migrateLegacyCompanionSize(400)).toBe(400);
    expect(migrateLegacyCompanionSize(480)).toBe(480);
    expect(migrateLegacyCompanionSize(900)).toBe(480);
    expect(migrateLegacyCompanionSize(100)).toBe(160);
    expect(migrateLegacyCompanionSize("big")).toBe(200);
    expect(migrateLegacyCompanionSize(undefined)).toBe(200);
  });
});

describe("parsing keeps valid fields and drops only invalid ones", () => {
  test("field-by-field", () => {
    expect(
      parseMimiPresenceState({
        visible: true,
        mode: "flying",
        size: 1000,
        dockedAnchor: { x: 10.6, y: "x" },
        movingAnchor: { x: 5.2, y: 6.7 },
      }),
    ).toEqual({
      schemaVersion: 1,
      visible: true,
      mode: "docked",
      size: 480,
      movingAnchor: { x: 5, y: 7 },
    });
    expect(parseMimiPresenceState([1, 2])).toEqual(defaultMimiPresenceState());
    expect(parseMimiPresenceState(null)).toEqual(defaultMimiPresenceState());
    // A saved 320 in the NEW file is an explicit choice and is kept.
    expect(parseMimiPresenceState({ size: 320 }).size).toBe(320);
  });
});

describe("legacy migration", () => {
  test("companion enabled=true → visible in moving mode with its anchor and migrated size", () => {
    expect(
      migrateLegacyMimiPresence({
        companion: { enabled: true, size: 320, anchor: { x: 100, y: 200 } },
        widget: { x: 1700, y: 950 },
      }),
    ).toEqual({
      schemaVersion: 1,
      visible: true,
      mode: "moving",
      size: 200,
      movingAnchor: { x: 100, y: 200 },
      dockedAnchor: { x: 1700, y: 950 },
    });
  });

  test("companion disabled or absent → hidden and docked (widget was never restored before)", () => {
    expect(migrateLegacyMimiPresence({ companion: { enabled: false, size: 400 } })).toMatchObject({
      visible: false,
      mode: "docked",
      size: 400,
    });
    expect(migrateLegacyMimiPresence({ widget: { x: 1, y: 2 } })).toEqual({
      ...defaultMimiPresenceState(),
      dockedAnchor: { x: 1, y: 2 },
    });
    // Invalid legacy fields fall back individually.
    expect(
      migrateLegacyMimiPresence({
        companion: { enabled: "yes", size: "x", anchor: { x: NaN, y: 1 } },
      }),
    ).toEqual(defaultMimiPresenceState());
  });
});

describe("loading from disk", () => {
  test("no files → default; nothing is written by loading", async () => {
    const { root, paths } = await fixture();
    expect(await loadMimiPresenceState(paths)).toEqual({
      state: defaultMimiPresenceState(),
      source: "default",
      quarantined: undefined,
    });
    expect(await readdir(root)).toEqual([]);
  });

  test("legacy files migrate, and legacy files are left byte-for-byte untouched", async () => {
    const { paths } = await fixture();
    const companion = JSON.stringify({ enabled: true, size: 320, anchor: { x: 40, y: 50 } });
    const widget = JSON.stringify({ x: 1200, y: 700 });
    await put(paths.legacyCompanionPath, companion);
    await put(paths.legacyWidgetPath, widget);
    const loaded = await loadMimiPresenceState(paths);
    expect(loaded.source).toBe("migrated");
    expect(loaded.state).toMatchObject({
      visible: true,
      mode: "moving",
      size: 200,
      movingAnchor: { x: 40, y: 50 },
      dockedAnchor: { x: 1200, y: 700 },
    });
    expect(await readFile(paths.legacyCompanionPath, "utf8")).toBe(companion);
    expect(await readFile(paths.legacyWidgetPath, "utf8")).toBe(widget);
  });

  test("a corrupt legacy companion file does not throw and keeps the valid widget position", async () => {
    const { paths } = await fixture();
    await put(paths.legacyCompanionPath, "{not json");
    await put(paths.legacyWidgetPath, JSON.stringify({ x: 9, y: 8 }));
    const loaded = await loadMimiPresenceState(paths);
    expect(loaded.state).toEqual({ ...defaultMimiPresenceState(), dockedAnchor: { x: 9, y: 8 } });
    expect(await readFile(paths.legacyCompanionPath, "utf8")).toBe("{not json");
  });

  test("the current file wins over legacy files", async () => {
    const { paths } = await fixture();
    await put(paths.statePath, JSON.stringify({ visible: false, mode: "moving", size: 240 }));
    await put(paths.legacyCompanionPath, JSON.stringify({ enabled: true }));
    expect(await loadMimiPresenceState(paths)).toEqual({
      state: { schemaVersion: 1, visible: false, mode: "moving", size: 240 },
      source: "current",
    });
  });

  test("an unreadable current file is copied aside, never overwritten by loading", async () => {
    const { paths } = await fixture();
    await put(paths.statePath, "\u0000garbage");
    await put(paths.legacyCompanionPath, JSON.stringify({ enabled: true, size: 400 }));
    const loaded = await loadMimiPresenceState(paths, () => 42);
    expect(loaded.quarantined).toBe(`${paths.statePath}.corrupt-42`);
    expect(await readFile(`${paths.statePath}.corrupt-42`, "utf8")).toBe("\u0000garbage");
    expect(await readFile(paths.statePath, "utf8")).toBe("\u0000garbage");
    expect(loaded.state).toMatchObject({ visible: true, mode: "moving", size: 400 });
  });
});

describe("writer", () => {
  test("writes are ordered and atomic (no temporary files left behind)", async () => {
    const { paths } = await fixture();
    const write = createMimiPresenceWriter(paths.statePath);
    const states = [160, 200, 240, 320, 400, 480].map((size) => ({
      ...defaultMimiPresenceState(),
      size,
    }));
    await Promise.all(states.map((state) => write(state)));
    expect(JSON.parse(await readFile(paths.statePath, "utf8")).size).toBe(480);
    const entries = await readdir(join(paths.statePath, ".."));
    expect(entries).toEqual(["mimi-presence.json"]);
  });

  test("a failed write does not block the next one", async () => {
    const { root, paths } = await fixture();
    // A directory where the parent should be makes the first write fail.
    await put(join(root, "blocked"), "file, not a directory");
    const bad = createMimiPresenceWriter(join(root, "blocked", "mimi-presence.json"));
    await expect(bad(defaultMimiPresenceState())).rejects.toBeDefined();
    const write = createMimiPresenceWriter(paths.statePath);
    await write({ ...defaultMimiPresenceState(), visible: true });
    expect(JSON.parse(await readFile(paths.statePath, "utf8")).visible).toBe(true);
  });
});

describe("feet geometry (DIP, no scaleFactor)", () => {
  test("docked feet are the bottom centre of the 96 DIP pet inside the 112 anchor", () => {
    expect(dockedFeet({ x: 100, y: 200 })).toEqual({ x: 156, y: 304 });
    expect(dockedAnchorForFeet({ x: 156, y: 304 })).toEqual({ x: 100, y: 200 });
  });

  test("moving feet use the drawn height and companionFeetOffset, not 0.9×size", () => {
    for (const height of [96, 110, 160, 200, 480]) {
      const anchor = { x: 500, y: 300 };
      const feet = movingFeet(anchor, height);
      expect(feet.y).toBeCloseTo(300 + height - companionFeetOffset(height));
      expect(feet.y).not.toBeCloseTo(300 + height * 0.9);
      const back = movingAnchorForFeet(feet, height);
      expect(Math.abs(back.x - anchor.x)).toBeLessThanOrEqual(1);
      expect(Math.abs(back.y - anchor.y)).toBeLessThanOrEqual(1);
    }
  });

  test("docked → moving → docked keeps the same standing point within rounding", () => {
    const docked = { x: 1700, y: 950 };
    const feet = dockedFeet(docked);
    const moving = movingAnchorForFeet(feet, 200);
    const again = dockedAnchorForFeet(movingFeet(moving, 200));
    expect(Math.abs(again.x - docked.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(again.y - docked.y)).toBeLessThanOrEqual(1);
  });
});
