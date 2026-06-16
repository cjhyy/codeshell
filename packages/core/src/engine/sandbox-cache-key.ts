/**
 * sandboxCacheKey — cache key for a resolved sandbox backend. Includes every
 * field that affects the backend (mode, network, writableRoots, deniedReads)
 * plus cwd. The key was previously `${mode}:${cwd}`, which ignored network /
 * roots / reads — so editing those in 设置页 hit the stale cached backend and
 * didn't take effect until app restart. Stable JSON shape so equal configs map
 * to equal keys.
 */
import type { SandboxConfig } from "../tool-system/sandbox/index.js";

export function sandboxCacheKey(config: SandboxConfig, cwd: string): string {
  return JSON.stringify({
    mode: config.mode,
    network: config.network,
    writableRoots: config.writableRoots,
    deniedReads: config.deniedReads,
    cwd,
  });
}
