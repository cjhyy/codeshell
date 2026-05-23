import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

export type TrustLevel = "trusted" | "untrusted";

interface TrustMap {
  [path: string]: TrustLevel;
}

const FILE = path.join(os.homedir(), ".code-shell", "desktop", "trust.json");

async function load(): Promise<TrustMap> {
  try {
    const raw = await fs.readFile(FILE, "utf8");
    return JSON.parse(raw) as TrustMap;
  } catch {
    return {};
  }
}

async function save(map: TrustMap): Promise<void> {
  try {
    await fs.mkdir(path.dirname(FILE), { recursive: true });
    await fs.writeFile(FILE, JSON.stringify(map, null, 2), "utf8");
  } catch {
    // best effort
  }
}

export async function getTrust(p: string): Promise<TrustLevel | "unknown"> {
  const map = await load();
  return map[p] ?? "unknown";
}

export async function setTrust(p: string, level: TrustLevel): Promise<void> {
  const map = await load();
  map[p] = level;
  await save(map);
}
