import { execFile } from "node:child_process";

export interface ScreenWindow {
  pid: number;
  app: string;
  frame: { x: number; y: number; width: number; height: number };
}

/** Front-to-back on-screen app windows: owner pid, app name and frame only.
 * CoreGraphics through the JXA ObjC bridge; no Apple Events, no window titles,
 * so neither Automation nor Screen Recording permission is involved. */
const LIST_WINDOWS = `ObjC.import("CoreGraphics");
function run() {
  const list = ObjC.castRefToObject($.CGWindowListCopyWindowInfo($.kCGWindowListOptionOnScreenOnly | $.kCGWindowListExcludeDesktopElements, 0));
  const out = [];
  for (let i = 0; i < list.count; i++) {
    const item = list.objectAtIndex(i);
    if (ObjC.unwrap(item.objectForKey("kCGWindowLayer")) !== 0) continue;
    if (ObjC.unwrap(item.objectForKey("kCGWindowAlpha")) === 0) continue;
    const bounds = item.objectForKey("kCGWindowBounds");
    out.push([ObjC.unwrap(item.objectForKey("kCGWindowOwnerPID")), ObjC.unwrap(item.objectForKey("kCGWindowOwnerName")), ObjC.unwrap(bounds.objectForKey("X")), ObjC.unwrap(bounds.objectForKey("Y")), ObjC.unwrap(bounds.objectForKey("Width")), ObjC.unwrap(bounds.objectForKey("Height"))]);
  }
  return JSON.stringify(out);
}`;

/** Overlays that sit above real windows without being one the user means. */
const OVERLAY_APPS = new Set(["cua-driver", "CodeShell Computer Use", "Window Server", "Dock"]);

const finite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= 100_000;

/** Keep only well-formed rows; app names are bounded display strings. */
export function parseScreenWindows(raw: string): ScreenWindow[] {
  let rows: unknown;
  try {
    rows = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(rows)) return [];
  const windows: ScreenWindow[] = [];
  for (const row of rows.slice(0, 500)) {
    if (!Array.isArray(row) || row.length !== 6) continue;
    const [pid, app, x, y, width, height] = row;
    if (!Number.isSafeInteger(pid) || pid <= 0 || typeof app !== "string" || !app) continue;
    if (!finite(x) || !finite(y) || !finite(width) || !finite(height)) continue;
    if (width < 40 || height < 40) continue;
    windows.push({ pid, app: app.slice(0, 80), frame: { x, y, width, height } });
  }
  return windows;
}

/** The frontmost real window under `point`, skipping our own and overlays. */
export function hitTestWindows(
  windows: readonly ScreenWindow[],
  point: { x: number; y: number },
  ownPids: ReadonlySet<number>,
): ScreenWindow | undefined {
  return windows.find(
    (window) =>
      !ownPids.has(window.pid) &&
      !OVERLAY_APPS.has(window.app) &&
      point.x >= window.frame.x &&
      point.y >= window.frame.y &&
      point.x < window.frame.x + window.frame.width &&
      point.y < window.frame.y + window.frame.height,
  );
}

/** One bounded, read-only listing per user drop. Never polled. */
export function windowAtPoint(
  point: { x: number; y: number },
  ownPids: ReadonlySet<number>,
): Promise<ScreenWindow | undefined> {
  if (process.platform !== "darwin") return Promise.resolve(undefined);
  return new Promise((resolve) => {
    execFile(
      "/usr/bin/osascript",
      ["-l", "JavaScript", "-e", LIST_WINDOWS],
      { timeout: 2_000, maxBuffer: 512 * 1024 },
      (error, stdout) =>
        resolve(error ? undefined : hitTestWindows(parseScreenWindows(stdout), point, ownPids)),
    );
  });
}
