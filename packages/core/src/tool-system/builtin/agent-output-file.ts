/**
 * Background-agent output files. When an async (run_in_background) agent
 * finishes, we mirror its final text to `~/.code-shell/agents/<agentId>.txt`
 * so it can be tailed from outside the process or read back in a later session
 * — the notificationQueue re-injection remains the PRIMARY path that feeds the
 * result to the parent agent; this file is just an external-readable copy.
 *
 * All writes are best-effort: a failure here must never break the agent
 * completion path, so callers fire-and-forget and we swallow errors (logging
 * via the provided logger when present).
 */

import { join } from "node:path";
import { mkdir, writeFile, rm, readdir } from "node:fs/promises";
import { userHome } from "../../settings/manager.js";

/** Directory holding per-agent output files. */
export function agentOutputDir(): string {
  return join(userHome(), ".code-shell", "agents");
}

/** Absolute path of a given agent's output file. */
export function agentOutputPath(agentId: string): string {
  // agentId is internally generated (`agent-<n>` / uuid-ish) — no separators —
  // but guard anyway so a hostile id can't escape the directory.
  const safe = agentId.replace(/[^A-Za-z0-9._-]/g, "_");
  return join(agentOutputDir(), `${safe}.txt`);
}

interface WriteOpts {
  status: "completed" | "failed";
  /** Final text (completed) or error message (failed). */
  body: string;
  description?: string;
  name?: string;
  /** Optional logger.warn for swallowed errors. */
  onError?: (msg: string, meta: Record<string, unknown>) => void;
}

/**
 * Write (overwrite) an agent's output file. Best-effort: resolves even on
 * failure. The body is prefixed with a small header so a human tailing the
 * file sees what it is.
 */
export async function writeAgentOutputFile(
  agentId: string,
  opts: WriteOpts,
): Promise<void> {
  try {
    await mkdir(agentOutputDir(), { recursive: true });
    const header =
      `# agent ${agentId}` +
      (opts.name ? ` (${opts.name})` : "") +
      `\n# status: ${opts.status}` +
      (opts.description ? `\n# task: ${opts.description}` : "") +
      `\n\n`;
    await writeFile(agentOutputPath(agentId), header + (opts.body ?? ""), "utf8");
  } catch (e) {
    opts.onError?.("agent_output_file_write_failed", {
      agentId,
      error: String(e instanceof Error ? e.message : e),
    });
  }
}

/** Delete a single agent's output file (best-effort). */
export async function removeAgentOutputFile(agentId: string): Promise<void> {
  try {
    await rm(agentOutputPath(agentId), { force: true });
  } catch {
    // best-effort
  }
}

/**
 * Remove every agent output file. Called on app exit / full registry reset so
 * the directory doesn't accumulate stale files across runs.
 */
export async function clearAgentOutputFiles(): Promise<void> {
  try {
    const dir = agentOutputDir();
    const names = await readdir(dir);
    await Promise.all(
      names
        .filter((n) => n.endsWith(".txt"))
        .map((n) => rm(join(dir, n), { force: true })),
    );
  } catch {
    // dir may not exist yet — fine
  }
}
