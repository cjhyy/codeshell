import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import {
  companionFeetOffset,
  companionSize,
  isMimiAppearance,
  MIMI_COMPANION_DEFAULT_SIZE,
  MIMI_COMPANION_LEGACY_DEFAULT_SIZE,
  MIMI_DEFAULT_APPEARANCE,
  type MimiAppearance,
} from "../../shared/mimi-companion.js";
import { isMimiPresenceMode, type MimiPresenceMode } from "../../shared/mimi-presence.js";
import { PET_WIDGET_WINDOW_SIZE } from "./pet-widget-geometry.js";

export interface Point {
  x: number;
  y: number;
}

/** Persisted presence. Positions are global Electron DIP coordinates. */
export interface MimiPresenceState {
  schemaVersion: 1;
  visible: boolean;
  mode: MimiPresenceMode;
  size: number;
  /** Which character plays the moving form. */
  appearance: MimiAppearance;
  /** Top-left of the 112×112 pet anchor (the former pet-widget.json). */
  dockedAnchor?: Point;
  /** Top-left of the moving character box where the user pinned it. */
  movingAnchor?: Point;
}

export const MIMI_PRESENCE_FILE = "mimi-presence.json";

export function defaultMimiPresenceState(): MimiPresenceState {
  return {
    schemaVersion: 1,
    visible: false,
    mode: "docked",
    size: MIMI_COMPANION_DEFAULT_SIZE,
    appearance: MIMI_DEFAULT_APPEARANCE,
  };
}

export function validPresencePoint(value: unknown): value is Point {
  if (!value || typeof value !== "object") return false;
  const point = value as { x?: unknown; y?: unknown };
  return (
    typeof point.x === "number" &&
    typeof point.y === "number" &&
    Number.isFinite(point.x) &&
    Number.isFinite(point.y) &&
    Math.abs(point.x) < 100_000 &&
    Math.abs(point.y) < 100_000
  );
}

const roundPoint = (point: Point): Point => ({ x: Math.round(point.x), y: Math.round(point.y) });

/**
 * Legacy moving size. 320 was the default and the old file cannot tell "never
 * changed" from "chose 320", so it moves to the new default; any other valid
 * choice is kept and clamped to the new range.
 */
export function migrateLegacyCompanionSize(value: unknown): number {
  if (value === MIMI_COMPANION_LEGACY_DEFAULT_SIZE) return MIMI_COMPANION_DEFAULT_SIZE;
  return companionSize(value);
}

/** Field-by-field read: an invalid field falls back alone, never the whole file. */
export function parseMimiPresenceState(raw: unknown): MimiPresenceState {
  const state = defaultMimiPresenceState();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return state;
  const value = raw as Record<string, unknown>;
  if (typeof value.visible === "boolean") state.visible = value.visible;
  if (isMimiPresenceMode(value.mode)) state.mode = value.mode;
  if (typeof value.size === "number" && Number.isFinite(value.size))
    state.size = companionSize(value.size);
  if (isMimiAppearance(value.appearance)) state.appearance = value.appearance;
  if (validPresencePoint(value.dockedAnchor)) state.dockedAnchor = roundPoint(value.dockedAnchor);
  if (validPresencePoint(value.movingAnchor)) state.movingAnchor = roundPoint(value.movingAnchor);
  return state;
}

/**
 * First launch with the unified owner. Legacy files are read only, never
 * rewritten or deleted, so a rollback still finds them.
 * - mimi-companion.json enabled=true → visible in moving mode;
 * - otherwise hidden and docked (the widget was never restored before);
 * - pet-widget.json position → docked anchor; companion anchor → moving anchor.
 */
export function migrateLegacyMimiPresence(legacy: {
  companion?: unknown;
  widget?: unknown;
}): MimiPresenceState {
  const state = defaultMimiPresenceState();
  const companion =
    legacy.companion && typeof legacy.companion === "object" && !Array.isArray(legacy.companion)
      ? (legacy.companion as Record<string, unknown>)
      : undefined;
  if (companion?.enabled === true) {
    state.visible = true;
    state.mode = "moving";
  }
  if (companion && "size" in companion) state.size = migrateLegacyCompanionSize(companion.size);
  if (companion && validPresencePoint(companion.anchor))
    state.movingAnchor = roundPoint(companion.anchor);
  if (validPresencePoint(legacy.widget)) state.dockedAnchor = roundPoint(legacy.widget);
  return state;
}

type ReadResult = { kind: "missing" } | { kind: "unreadable" } | { kind: "ok"; value: unknown };

async function readJson(file: string): Promise<ReadResult> {
  let text: string;
  try {
    text = await fs.readFile(file, "utf8");
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === "ENOENT"
      ? { kind: "missing" }
      : { kind: "unreadable" };
  }
  try {
    return { kind: "ok", value: JSON.parse(text) };
  } catch {
    return { kind: "unreadable" };
  }
}

export interface MimiPresenceLoadResult {
  state: MimiPresenceState;
  source: "current" | "migrated" | "default";
  /** The current file existed but could not be parsed; it was copied aside, not overwritten. */
  quarantined?: string;
}

export interface MimiPresenceStorePaths {
  /** codeShellHome()/desktop/mimi-presence.json */
  statePath: string;
  /** app.getPath("userData")/mimi-companion.json (read only). */
  legacyCompanionPath: string;
  /** codeShellHome()/desktop/pet-widget.json (read only). */
  legacyWidgetPath: string;
}

export async function loadMimiPresenceState(
  paths: MimiPresenceStorePaths,
  now: () => number = Date.now,
): Promise<MimiPresenceLoadResult> {
  const current = await readJson(paths.statePath);
  if (current.kind === "ok")
    return { state: parseMimiPresenceState(current.value), source: "current" };
  let quarantined: string | undefined;
  if (current.kind === "unreadable") {
    // Keep the unreadable bytes for inspection; later writes replace only the
    // canonical name, never this copy.
    const copy = `${paths.statePath}.corrupt-${now()}`;
    await fs.copyFile(paths.statePath, copy).then(
      () => (quarantined = copy),
      () => undefined,
    );
  }
  const [companion, widget] = await Promise.all([
    readJson(paths.legacyCompanionPath),
    readJson(paths.legacyWidgetPath),
  ]);
  if (companion.kind === "missing" && widget.kind === "missing")
    return { state: defaultMimiPresenceState(), source: "default", quarantined };
  return {
    state: migrateLegacyMimiPresence({
      companion: companion.kind === "ok" ? companion.value : undefined,
      widget: widget.kind === "ok" ? widget.value : undefined,
    }),
    source: "migrated",
    quarantined,
  };
}

/** Ordered, atomic writer (unique tmp + rename). Only this process writes the file. */
export function createMimiPresenceWriter(statePath: string) {
  let queue = Promise.resolve();
  return (state: MimiPresenceState): Promise<void> => {
    const snapshot = `${JSON.stringify(state, null, 2)}\n`;
    const write = queue.then(async () => {
      await fs.mkdir(path.dirname(statePath), { recursive: true, mode: 0o700 });
      const temporary = `${statePath}.tmp-${process.pid}-${randomUUID()}`;
      try {
        await fs.writeFile(temporary, snapshot, { encoding: "utf8", flag: "wx", mode: 0o600 });
        await fs.rename(temporary, statePath);
      } finally {
        await fs.rm(temporary, { force: true });
      }
    });
    queue = write.catch(() => {});
    return write;
  };
}

// ---- Keeping Mimi in the same place across forms -------------------------
// The pet image is 96×96 centred in the 112×112 anchor, so its bottom edge sits
// 8 DIP above the anchor's bottom.
const DOCKED_FEET_X = PET_WIDGET_WINDOW_SIZE / 2;
const DOCKED_FEET_Y = PET_WIDGET_WINDOW_SIZE - (PET_WIDGET_WINDOW_SIZE - 96) / 2;

export function dockedFeet(anchor: Point): Point {
  return { x: anchor.x + DOCKED_FEET_X, y: anchor.y + DOCKED_FEET_Y };
}

export function dockedAnchorForFeet(feet: Point): Point {
  return roundPoint({ x: feet.x - DOCKED_FEET_X, y: feet.y - DOCKED_FEET_Y });
}

/** Visual feet of a moving character box drawn `height` tall at `anchor`. */
export function movingFeet(anchor: Point, height: number): Point {
  return { x: anchor.x + height * 0.35, y: anchor.y + height - companionFeetOffset(height) };
}

export function movingAnchorForFeet(feet: Point, height: number): Point {
  return roundPoint({
    x: feet.x - height * 0.35,
    y: feet.y - height + companionFeetOffset(height),
  });
}
