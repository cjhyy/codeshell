import { spawn, type ChildProcess } from "node:child_process";
import { delimiter } from "node:path";
import type {
  ExternalAgentAdapter,
  ExternalAgentEvent,
  ExternalAgentJob,
  ExternalAgentKind,
  ExternalAgentMode,
  StartExternalAgentJobInput,
} from "../types.js";
import { killProcessGroup } from "../../runtime/spawn-common.js";

/**
 * macOS GUI-launched processes (Electron from Dock/Finder) inherit a minimal
 * PATH that excludes Homebrew (/opt/homebrew/bin) and /usr/local/bin — so a
 * bare `spawn("claude")` fails with ENOENT even though the user's shell finds
 * it. We prepend the common CLI install dirs (deduped, missing ones harmless).
 */
export function pathWithCommonBins(env: NodeJS.ProcessEnv = process.env): string {
  const extra = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"];
  const current = (env.PATH ?? "").split(delimiter).filter(Boolean);
  const merged: string[] = [];
  for (const dir of [...extra, ...current]) {
    if (!merged.includes(dir)) merged.push(dir);
  }
  return merged.join(delimiter);
}

export function buildClaudeCodeSpawn(input: {
  command: string;
  prompt: string;
  mode: ExternalAgentMode;
  args: string[];
  kind?: ExternalAgentKind;
}): { command: string; args: string[] } {
  // Claude Code defaults to an interactive TUI; -p/--print runs it
  // non-interactively (prints the response and exits) which is what a managed
  // background job needs. Codex is left to its own argv.
  const lead = input.kind === "claude-code" ? ["--print"] : [];
  return { command: input.command, args: [...lead, ...input.args, input.prompt] };
}

export class ClaudeCodeAdapter implements ExternalAgentAdapter {
  private children = new Map<string, ChildProcess>();

  start(
    input: StartExternalAgentJobInput,
    onEvent: (event: ExternalAgentEvent) => void,
  ): ExternalAgentJob {
    const id = `cc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const mode = input.mode ?? "safe";
    const args = input.args ?? [];
    const spawnSpec = buildClaudeCodeSpawn({
      command: input.command,
      prompt: input.prompt,
      mode,
      args,
      kind: input.kind,
    });
    const job: ExternalAgentJob = {
      id,
      kind: input.kind,
      sessionId: input.sessionId,
      cwd: input.cwd,
      prompt: input.prompt,
      mode,
      args,
      status: "running",
      startedAt: Date.now(),
    };

    const child = spawn(spawnSpec.command, spawnSpec.args, {
      cwd: input.cwd,
      env: { ...process.env, PATH: pathWithCommonBins() },
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.children.set(id, child);
    onEvent({ type: "job.started", job });

    child.stdout?.on("data", (chunk) => {
      onEvent({ type: "job.output", jobId: id, stream: "stdout", text: String(chunk) });
    });
    child.stderr?.on("data", (chunk) => {
      onEvent({ type: "job.output", jobId: id, stream: "stderr", text: String(chunk) });
    });
    child.on("error", (err) => {
      this.children.delete(id);
      const failed: ExternalAgentJob = { ...job, status: "failed", completedAt: Date.now() };
      const isMissing = (err as NodeJS.ErrnoException).code === "ENOENT";
      const friendly = isMissing
        ? `未找到命令 "${input.command}"。请先安装对应 CLI(${
            input.kind === "codex" ? "Codex" : "Claude Code"
          })并确保它在 PATH 中。`
        : err.message;
      onEvent({ type: "job.failed", job: failed, error: friendly });
    });
    child.on("exit", (exitCode, signal) => {
      this.children.delete(id);
      const completed: ExternalAgentJob = {
        ...job,
        status: exitCode === 0 ? "completed" : "failed",
        completedAt: Date.now(),
        exitCode,
        signal,
      };
      if (exitCode === 0) onEvent({ type: "job.completed", job: completed });
      else
        onEvent({
          type: "job.failed",
          job: completed,
          error: `Exited with ${signal ?? exitCode}`,
        });
    });
    return job;
  }

  async stop(jobId: string): Promise<boolean> {
    const child = this.children.get(jobId);
    if (!child?.pid) return false;
    await killProcessGroup(child.pid, { graceMs: 3000 });
    this.children.delete(jobId);
    return true;
  }
}
