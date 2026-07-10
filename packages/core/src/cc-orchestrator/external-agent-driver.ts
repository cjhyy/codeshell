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
const CODEX_IMAGE_PROBE_TIMEOUT_MS = 5_000;
const AGENT_TERMINATE_GRACE_MS = 500;

function abortError(): Error {
  const err = new Error("Agent run aborted");
  err.name = "AbortError";
  return err;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

function createCodexImageProbe(
  command: string,
  cwd: string,
  signal?: AbortSignal,
): Promise<boolean> {
  return new Promise<boolean>((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    const child = spawn(command, ["exec", "--help"], {
      cwd,
      env: { ...process.env, PATH: pathWithCommonBins() },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    const done = (value: boolean) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };
    const fail = (err: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };
    const killProbe = () => {
      try {
        child.kill("SIGTERM");
      } catch {
        // already gone
      }
    };
    const onAbort = () => {
      killProbe();
      fail(abortError());
    };
    const timer = setTimeout(() => {
      killProbe();
      done(false);
    }, CODEX_IMAGE_PROBE_TIMEOUT_MS);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
    child.stdout?.on("data", (chunk: Buffer) => {
      out += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      out += chunk.toString("utf8");
    });
    child.on("error", () => done(false));
    child.on("exit", () => done(/(?:^|\s)-i(?:,|\s)|--image\b/.test(out)));
  });
}

export function detectCodexImageInput(
  command: string,
  cwd: string,
  signal?: AbortSignal,
): Promise<boolean> {
  if (signal) return createCodexImageProbe(command, cwd, signal);
  const cached = codexImageFlagCache.get(command);
  if (cached) return cached;
  const probe = createCodexImageProbe(command, cwd);
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
      throwIfAborted(signal);
      const codexImageInputSupported =
        adapter.kind === "codex" && (opts.imagePaths?.length ?? 0) > 0
          ? await detectCodexImageInput(opts.command, opts.cwd, signal).catch((err) => {
              if (signal?.aborted || (err as Error)?.name === "AbortError") throw err;
              return false;
            })
          : false;
      throwIfAborted(signal);
      const args = adapter.buildArgs({
        prompt: opts.prompt,
        resumeSessionId: opts.resumeSessionId,
        model: opts.model,
        permissionMode: opts.permissionMode ?? "default",
        cwd: opts.cwd,
        imagePaths: opts.imagePaths,
        codexImageInputSupported,
      });
      throwIfAborted(signal);
      // claude takes the prompt in argv (`-p <prompt>`) and wants stdin closed
      // (verified: avoids a 3s wait). codex `exec` reads the prompt from stdin
      // (argv ends with `-`), so adapters that set promptViaStdin get a piped
      // stdin we write the prompt to.
      const viaStdin = adapter.promptViaStdin === true;
      const useProcessGroup = process.platform !== "win32";
      const child = spawn(opts.command, args, {
        cwd: opts.cwd,
        env: { ...process.env, PATH: pathWithCommonBins() },
        // POSIX detached children lead a fresh process group. We keep their
        // stdio attached and their ChildProcess referenced, but can terminate
        // the whole CLI tree on cancel instead of leaving helper processes that
        // continue editing after the DriveAgent job is marked cancelled.
        detached: useProcessGroup,
        stdio: [viaStdin ? "pipe" : "ignore", "pipe", "pipe"],
      });
      let settled = false;
      let abortRequested = false;
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      const killTree = (killSignal: NodeJS.Signals) => {
        if (useProcessGroup && child.pid) {
          try {
            process.kill(-child.pid, killSignal);
            return;
          } catch {
            // The group may already be gone or unavailable; fall back to the
            // direct child handle so Windows-like/runtime edge cases still stop.
          }
        }
        try {
          child.kill(killSignal);
        } catch {
          // already gone
        }
      };
      const cleanup = () => {
        signal?.removeEventListener("abort", onAbort);
        // After abort, retain the escalation timer even if the group leader
        // exits first: a stubborn descendant may still own the process group.
        if (!abortRequested && killTimer) clearTimeout(killTimer);
      };
      const onAbort = () => {
        if (abortRequested) return;
        abortRequested = true;
        killTree("SIGTERM");
        killTimer = setTimeout(() => killTree("SIGKILL"), AGENT_TERMINATE_GRACE_MS);
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) onAbort();
      if (viaStdin && child.stdin) {
        child.stdin.end(opts.prompt);
      }
      const lines: string[] = [];
      if (child.stdout) {
        const rl = createInterface({ input: child.stdout });
        rl.on("line", (line) => lines.push(line));
      }
      child.on("error", (err) => {
        if (settled) return;
        settled = true;
        cleanup();
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
        if (settled) return;
        settled = true;
        cleanup();
        resolve(runWithLines(adapter, lines, code));
      });
    })().catch(reject);
  });
}
