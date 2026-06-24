import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { AgentAdapter, BuildArgsOpts, PermissionMode } from "./agent-adapter.js";
import { pathWithCommonBins } from "./cc-capability.js";

export interface AgentRunResult {
  sessionId: string;
  finalText: string;
  isError: boolean;
  exitCode: number | null;
  lines: string[];
}

/** Pure: reduce collected output lines + exit code to a result. Unit-testable. */
export function runWithLines(adapter: AgentAdapter, lines: string[], exitCode: number | null): AgentRunResult {
  const parsed = adapter.parseResult(lines);
  return { ...parsed, exitCode, lines };
}

export interface DriverRunOpts extends Omit<BuildArgsOpts, "permissionMode"> {
  permissionMode?: PermissionMode;
}

/** Spawn ONE headless agent run, collect stream-json to exit, return result.
 *  No time concept — a single turn. Honors AbortSignal (kills the child). */
export function runAgentOnce(
  adapter: AgentAdapter,
  opts: DriverRunOpts & { command: string },
  signal?: AbortSignal,
): Promise<AgentRunResult> {
  return new Promise((resolve, reject) => {
    const args = adapter.buildArgs({
      prompt: opts.prompt,
      resumeSessionId: opts.resumeSessionId,
      permissionMode: opts.permissionMode ?? "default",
      cwd: opts.cwd,
    });
    const child = spawn(opts.command, args, {
      cwd: opts.cwd,
      env: { ...process.env, PATH: pathWithCommonBins() },
      // NOT detached: this child is owned by the (long-lived) worker that reads
      // its stdout. Detaching orphaned it across a worker/app restart — the
      // reader promise then never resolved and the completion notification never
      // fired (the "后台任务没返回" bug). Bound to the worker, it lives or dies
      // with the process that's actually listening for its result.
      detached: false,
      stdio: ["ignore", "pipe", "pipe"], // close stdin (verified: avoids 3s wait)
    });
    const lines: string[] = [];
    if (child.stdout) {
      const rl = createInterface({ input: child.stdout });
      rl.on("line", (line) => lines.push(line));
    }
    // Not detached → no own process group, so kill the child directly (a
    // negative-pid group kill would target the worker's group). claude has no
    // long-lived child tree of its own here, so a direct SIGTERM is sufficient.
    const onAbort = () => {
      try { child.kill("SIGTERM"); } catch { /* already gone */ }
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    child.on("error", (err) => {
      signal?.removeEventListener("abort", onAbort);
      reject(err);
    });
    child.on("exit", (code) => {
      signal?.removeEventListener("abort", onAbort);
      resolve(runWithLines(adapter, lines, code));
    });
  });
}
