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
export function runWithLines(
  adapter: AgentAdapter,
  lines: string[],
  exitCode: number | null,
): AgentRunResult {
  const parsed = adapter.parseResult(lines);
  return { ...parsed, exitCode, lines };
}

export interface DriverRunOpts extends Omit<BuildArgsOpts, "permissionMode"> {
  permissionMode?: PermissionMode;
}

const codexImageFlagCache = new Map<string, Promise<boolean>>();

export function detectCodexImageInput(command: string, cwd: string): Promise<boolean> {
  const cached = codexImageFlagCache.get(command);
  if (cached) return cached;
  const probe = new Promise<boolean>((resolve) => {
    const child = spawn(command, ["exec", "--help"], {
      cwd,
      env: { ...process.env, PATH: pathWithCommonBins() },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let settled = false;
    const done = (value: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      try {
        child.kill("SIGTERM");
      } catch {
        // already gone
      }
      done(false);
    }, 2_000);
    child.stdout?.on("data", (chunk: Buffer) => {
      out += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      out += chunk.toString("utf8");
    });
    child.on("error", () => done(false));
    child.on("exit", () => done(/(?:^|\s)-i(?:,|\s)|--image\b/.test(out)));
  });
  codexImageFlagCache.set(command, probe);
  return probe;
}

/** Spawn ONE headless agent run, collect stream-json to exit, return result.
 *  No time concept — a single turn. Honors AbortSignal (kills the child). */
export function runAgentOnce(
  adapter: AgentAdapter,
  opts: DriverRunOpts & { command: string },
  signal?: AbortSignal,
): Promise<AgentRunResult> {
  return new Promise((resolve, reject) => {
    void (async () => {
      const codexImageInputSupported =
        adapter.kind === "codex" && (opts.imagePaths?.length ?? 0) > 0
          ? await detectCodexImageInput(opts.command, opts.cwd).catch(() => false)
          : false;
      const args = adapter.buildArgs({
        prompt: opts.prompt,
        resumeSessionId: opts.resumeSessionId,
        model: opts.model,
        permissionMode: opts.permissionMode ?? "default",
        cwd: opts.cwd,
        imagePaths: opts.imagePaths,
        codexImageInputSupported,
      });
      // claude takes the prompt in argv (`-p <prompt>`) and wants stdin closed
      // (verified: avoids a 3s wait). codex `exec` reads the prompt from stdin
      // (argv ends with `-`), so adapters that set promptViaStdin get a piped
      // stdin we write the prompt to.
      const viaStdin = adapter.promptViaStdin === true;
      const child = spawn(opts.command, args, {
        cwd: opts.cwd,
        env: { ...process.env, PATH: pathWithCommonBins() },
        // NOT detached: this child is owned by the (long-lived) worker that reads
        // its stdout. Detaching orphaned it across a worker/app restart — the
        // reader promise then never resolved and the completion notification never
        // fired (the "后台任务没返回" bug). Bound to the worker, it lives or dies
        // with the process that's actually listening for its result.
        detached: false,
        stdio: [viaStdin ? "pipe" : "ignore", "pipe", "pipe"],
      });
      if (viaStdin && child.stdin) {
        child.stdin.end(opts.prompt);
      }
      const lines: string[] = [];
      if (child.stdout) {
        const rl = createInterface({ input: child.stdout });
        rl.on("line", (line) => lines.push(line));
      }
      // Not detached → no own process group, so kill the child directly (a
      // negative-pid group kill would target the worker's group). claude has no
      // long-lived child tree of its own here, so a direct SIGTERM is sufficient.
      const onAbort = () => {
        try {
          child.kill("SIGTERM");
        } catch {
          /* already gone */
        }
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      child.on("error", (err) => {
        signal?.removeEventListener("abort", onAbort);
        // A missing binary is the most common failure (user hasn't installed the
        // CLI, or GUI-launched Electron's PATH misses it). Turn the cryptic
        // "spawn codex ENOENT" into something actionable that names the command.
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          reject(
            new Error(
              `未找到命令 "${opts.command}"。请先安装该 CLI 并确保它在 PATH 中（${adapter.kind === "codex" ? "Codex CLI" : "Claude Code CLI"}）。`,
            ),
          );
          return;
        }
        reject(err);
      });
      child.on("exit", (code) => {
        signal?.removeEventListener("abort", onAbort);
        resolve(runWithLines(adapter, lines, code));
      });
    })().catch(reject);
  });
}
