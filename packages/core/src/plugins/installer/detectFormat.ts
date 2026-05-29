import { existsSync } from "node:fs";
import { join } from "node:path";

/** Binary detection: a Codex plugin has `.codex-plugin/plugin.json`; everything else is CC. */
export function detectPluginFormat(sourceDir: string): "codex" | "cc" {
  return existsSync(join(sourceDir, ".codex-plugin", "plugin.json")) ? "codex" : "cc";
}
