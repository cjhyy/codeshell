/**
 * UI-side session metadata. The agent worker owns the canonical
 * session id; this store lets the user rename it to something
 * human-readable. Keyed by engine session id.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

interface TitleMap {
  [sessionId: string]: string;
}

const FILE = path.join(os.homedir(), ".code-shell", "desktop", "session-titles.json");

async function load(): Promise<TitleMap> {
  try {
    const raw = await fs.readFile(FILE, "utf8");
    return JSON.parse(raw) as TitleMap;
  } catch {
    return {};
  }
}

async function save(map: TitleMap): Promise<void> {
  try {
    await fs.mkdir(path.dirname(FILE), { recursive: true });
    await fs.writeFile(FILE, JSON.stringify(map, null, 2), "utf8");
  } catch {
    // best effort
  }
}

export async function listTitles(): Promise<TitleMap> {
  return load();
}

export async function setTitle(id: string, title: string): Promise<void> {
  const map = await load();
  if (title) map[id] = title;
  else delete map[id];
  await save(map);
}
