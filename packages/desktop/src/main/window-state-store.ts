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

export async function loadWindowState(): Promise<WindowState> {
  try {
    const raw = await fs.readFile(FILE, "utf8");
    const parsed = JSON.parse(raw) as Partial<WindowState>;
    return { ...DEFAULT, ...parsed };
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
