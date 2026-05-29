import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readInstalledPlugins } from "../installedPlugins.js";
import { CSMeta } from "./types.js";

export interface PluginListRow {
  name: string;
  format: "cc" | "codex";
  version?: string;
  source: string;
  installedAt: string;
}

/** Read .cs-meta.json from each registered plugin dir that has one (local installs). */
export function listInstalledPlugins(): PluginListRow[] {
  const rows: PluginListRow[] = [];
  const data = readInstalledPlugins();
  for (const entries of Object.values(data.plugins)) {
    for (const entry of entries) {
      const metaPath = join(entry.installPath, ".cs-meta.json");
      if (!existsSync(metaPath)) continue;
      try {
        const meta = CSMeta.parse(JSON.parse(readFileSync(metaPath, "utf-8")));
        rows.push({
          name: meta.name,
          format: meta.format,
          version: meta.version,
          source: meta.source,
          installedAt: meta.installedAt,
        });
      } catch {
        // not a local cs-managed install; skip
      }
    }
  }
  return rows;
}
