import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type {
  ExternalAgentAdapter,
  ExternalAgentEvent,
  ExternalAgentJob,
  ExternalAgentMode,
  StartExternalAgentJobInput,
} from "../types.js";
import { killProcessGroup } from "../../runtime/spawn-common.js";

export function buildClaudeCodeSpawn(input: {
  command: string;
  prompt: string;
  mode: ExternalAgentMode;
  args: string[];
}): { command: string; args: string[] } {
  return { command: input.command, args: [...input.args, input.prompt] };
}

export class ClaudeCodeAdapter implements ExternalAgentAdapter {
  private children = new Map<string, ChildProcessWithoutNullStreams>();

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
      env: process.env,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    }) as ChildProcessWithoutNullStreams;
    this.children.set(id, child);
    onEvent({ type: "job.started", job });

    child.stdout.on("data", (chunk) => {
      onEvent({ type: "job.output", jobId: id, stream: "stdout", text: String(chunk) });
    });
    child.stderr.on("data", (chunk) => {
      onEvent({ type: "job.output", jobId: id, stream: "stderr", text: String(chunk) });
    });
    child.on("error", (err) => {
      this.children.delete(id);
      const failed: ExternalAgentJob = { ...job, status: "failed", completedAt: Date.now() };
      onEvent({ type: "job.failed", job: failed, error: err.message });
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
