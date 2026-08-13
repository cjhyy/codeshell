import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { codeShellHome } from "@cjhyy/code-shell-core";

export interface WindowState {
  width: number;
  height: number;
  x?: number;
  y?: number;
  maximized?: boolean;
}

function defaultFile(): string {
  return path.join(codeShellHome(), "desktop", "window.json");
}

let file = defaultFile();
let writeQueue: Promise<void> = Promise.resolve();

/** Test-only isolation hook. */
export function __setWindowStateFileForTest(next: string | null): void {
  file = next ?? defaultFile();
  writeQueue = Promise.resolve();
}
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
  await writeQueue.catch(() => undefined);
  try {
    const raw = await fs.readFile(file, "utf8");
    return sanitizeWindowState(JSON.parse(raw));
  } catch {
    return DEFAULT;
  }
}

export async function saveWindowState(s: WindowState): Promise<void> {
  const target = file;
  const operation = writeQueue.then(async () => {
    const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      await fs.writeFile(temporary, `${JSON.stringify(sanitizeWindowState(s), null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
      await fs.rename(temporary, target);
    } finally {
      await fs.rm(temporary, { force: true }).catch(() => undefined);
    }
  });
  // Window persistence stays best-effort, but its queue must recover so one
  // transient failure does not suppress every later move/resize snapshot.
  writeQueue = operation.catch(() => undefined);
  await writeQueue;
}
