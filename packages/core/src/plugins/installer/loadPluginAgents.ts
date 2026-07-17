import { existsSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
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
    const pluginName = pluginNameFromKey(key);
    if (disabled.has(pluginName)) continue;
    for (const entry of entries) {
      const dir = join(entry.installPath, "agents");
      // Carry pluginName so a plugin agent's bare skill allowlist
      // (`director-skill`) can be namespaced to `<pluginName>:director-skill`
      // at spawn time — see resolveAgentTypeOverrides.
      if (!existsSync(dir)) continue;
      try {
        const installRoot = realpathSync(entry.installPath);
        const resolvedDir = realpathSync(dir);
        const rel = relative(installRoot, resolvedDir);
        if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) continue;
        if (statSync(resolvedDir).isDirectory()) {
          out.push({ dir, source: "plugin", pluginName });
        }
      } catch {
        // Missing, unreadable, or escaping plugin contribution — ignore it.
      }
    }
  }
  return out;
}
