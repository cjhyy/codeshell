import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

export interface WindowState {
  width: number;
  height: number;
  x?: number;
  y?: number;
  maximized?: boolean;
}

const FILE = path.join(os.homedir(), ".code-shell", "desktop", "window.json");
const DEFAULT: WindowState = { width: 1180, height: 800 };

const MIN_DIM = 200;
const MAX_DIM = 20_000;

/** A finite number within [min, max]; otherwise undefined. */
function validDim(v: unknown, min: number, max: number): number | undefined {
  return typeof v === "number" && Number.isFinite(v) && v >= min && v <= max ? v : undefined;
}

/**
 * Coerce a parsed (possibly corrupt) window state into a safe one. The stored
 * file is user-writable and could hold NaN / negative / out-of-range / wrong-
 * typed values that would break BrowserWindow (review-2026-05-30).
 */
export function sanitizeWindowState(parsed: unknown): WindowState {
  const p = (parsed ?? {}) as Record<string, unknown>;
  const out: WindowState = {
    width: validDim(p.width, MIN_DIM, MAX_DIM) ?? DEFAULT.width,
    height: validDim(p.height, MIN_DIM, MAX_DIM) ?? DEFAULT.height,
  };
  const x = validDim(p.x, -MAX_DIM, MAX_DIM);
  const y = validDim(p.y, -MAX_DIM, MAX_DIM);
  if (x !== undefined) out.x = x;
  if (y !== undefined) out.y = y;
  if (typeof p.maximized === "boolean") out.maximized = p.maximized;
  return out;
}

export async function loadWindowState(): Promise<WindowState> {
  try {
    const raw = await fs.readFile(FILE, "utf8");
    return sanitizeWindowState(JSON.parse(raw));
  } catch {
    return DEFAULT;
  }
}

export async function saveWindowState(s: WindowState): Promise<void> {
  try {
    await fs.mkdir(path.dirname(FILE), { recursive: true });
    await fs.writeFile(FILE, JSON.stringify(s, null, 2), "utf8");
  } catch {
    // best effort
  }
}
