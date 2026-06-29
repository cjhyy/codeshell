import { delimiter } from "node:path";

/**
 * macOS GUI-launched Electron has a minimal PATH (no Homebrew). Prepend common
 * CLI dirs so `claude` / `codex` resolve. Mirrors the external-agent adapter's
 * fix. Standalone (no heavy imports) so both resident-agent and codex-room-agent
 * can use it without dragging in core.
 */
export function pathWithCommonBins(env: NodeJS.ProcessEnv = process.env): string {
  const extra = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"];
  const current = (env.PATH ?? "").split(delimiter).filter(Boolean);
  const merged: string[] = [];
  for (const dir of [...extra, ...current]) if (!merged.includes(dir)) merged.push(dir);
  return merged.join(delimiter);
}
