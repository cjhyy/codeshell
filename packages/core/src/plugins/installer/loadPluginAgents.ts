import { existsSync } from "node:fs";
import { join } from "node:path";
import { readInstalledPlugins } from "../installedPlugins.js";
import type { AgentSourceDir } from "../../agent/agent-definition-registry.js";

function pluginNameFromKey(key: string): string {
  const at = key.lastIndexOf("@");
  return at > 0 ? key.slice(0, at) : key;
}

/** Agent source dirs contributed by installed plugins (each <installPath>/agents). */
export function pluginAgentDirs(disabledPlugins: string[] = []): AgentSourceDir[] {
  const disabled = new Set(disabledPlugins);
  const out: AgentSourceDir[] = [];
  const data = readInstalledPlugins();
  for (const [key, entries] of Object.entries(data.plugins)) {
    if (disabled.has(pluginNameFromKey(key))) continue;
    for (const entry of entries) {
      const dir = join(entry.installPath, "agents");
      if (existsSync(dir)) out.push({ dir, source: "plugin" });
    }
  }
  return out;
}
