import { execFile, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { AgentAdapter, BuildArgsOpts, PermissionMode } from "./agent-adapter.js";
import { pathWithCommonBins } from "./cc-capability.js";
import {
  killProcessGroup,
  recordExternalModelCall,
  type BackgroundJobProgress,
} from "@cjhyy/code-shell-core/extension";
import { advanceAgentProgressWith, initialAgentProgress } from "./external-agent-progress.js";

export interface AgentRunResult {
  sessionId: string;
  finalText: string;
  isError: boolean;
  exitCode: number | null;
  /** Complete CLI records; transient Claude token deltas are observed only. */
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
  /** Called once as soon as the external CLI reports its durable session/thread
   *  id. This normally happens near process startup, well before the turn exits. */
  onSessionId?: (sessionId: string) => void;
  /** Bounded activity metadata; never a second transcript stream. */
  onProgress?: (progress: BackgroundJobProgress) => void;
  /** Called once with the CLI's OS pid so retained history can tell whether
   *  the process outlived the worker that launched it. */
  onProcess?: (pid: number) => void;
}

/** After the CLI exits, a grandchild it backgrounded with inherited stdio can
 *  hold the pipes open forever, and `close` would never fire. */
const STDIO_RELEASE_GRACE_MS = 1_000;

const codexImageFlagCache = new Map<string, Promise<boolean>>();
const CODEX_IMAGE_PROBE_TIMEOUT_MS = 5_000;
const AGENT_TERMINATE_GRACE_MS = 500;

function listPosixProcessTree(rootPid: number): Promise<number[]> {
  return new Promise((resolve) => {
    execFile("ps", ["-axo", "pid=,ppid="], { encoding: "utf8" }, (err, stdout) => {
      if (err) {
        resolve([rootPid]);
        return;
      }
      const childrenByParent = new Map<number, number[]>();
      for (const line of stdout.split("\n")) {
        const [pidText, parentText] = line.trim().split(/\s+/, 2);
        const pid = Number(pidText);
        const parentPid = Number(parentText);
        if (!Number.isInteger(pid) || !Number.isInteger(parentPid)) continue;
        const children = childrenByParent.get(parentPid) ?? [];
        children.push(pid);
        childrenByParent.set(parentPid, children);
      }
      const pids: number[] = [];
      const visit = (pid: number) => {
        if (pids.includes(pid)) return;
        pids.push(pid);
        for (const childPid of childrenByParent.get(pid) ?? []) visit(childPid);
      };
      visit(rootPid);
      resolve(pids);
    });
  });
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForPidsToExit(pids: Set<number>, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while ([...pids].some(isPidAlive)) {
    if (Date.now() >= deadline) return false;
    await delay(25);
  }
  return true;
}

function signalPids(pids: Set<number>, killSignal: NodeJS.Signals): void {
  for (const pid of pids) {
    try {
      process.kill(pid, killSignal);
    } catch {
      // already gone
    }
  }
}

async function terminateAttachedProcessTree(child: {
  pid?: number;
  kill: (signal?: NodeJS.Signals) => boolean;
}): Promise<void> {
  const pid = child.pid;
  if (!pid) {
    try {
      child.kill("SIGKILL");
    } catch {
      // already gone
    }
    return;
  }
  if (process.platform === "win32") {
    // Windows has no POSIX SIGTERM semantics or negative-pid groups. Reap the
    // tree via taskkill, then use positive-pid process.kill as the fallback the
    // platform supports when taskkill is unavailable/races.
    await killProcessGroup(pid, { graceMs: AGENT_TERMINATE_GRACE_MS });
    if (isPidAlive(pid)) {
      try {
        process.kill(pid);
      } catch {
        // already gone
      }
    }
    return;
  }

  const trackedPids = new Set(await listPosixProcessTree(pid));
  signalPids(trackedPids, "SIGTERM");
  if (await waitForPidsToExit(trackedPids, AGENT_TERMINATE_GRACE_MS)) return;

  // Capture descendants created during the grace window while the leader is
  // still addressable, but retain the first snapshot so reparented stubborn
  // descendants cannot disappear from the escalation set.
  for (const treePid of await listPosixProcessTree(pid)) trackedPids.add(treePid);
  signalPids(trackedPids, "SIGKILL");
  await waitForPidsToExit(trackedPids, 1_000);
}

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
    let terminating = false;
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
    const onAbort = () => {
      if (settled || terminating) return;
      terminating = true;
      cleanup();
      void terminateAttachedProcessTree(child).then(() => fail(abortError()));
    };
    const timer = setTimeout(() => {
      if (settled || terminating) return;
      terminating = true;
      cleanup();
      void terminateAttachedProcessTree(child).then(() => done(false));
    }, CODEX_IMAGE_PROBE_TIMEOUT_MS);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
    child.stdout?.on("data", (chunk: Buffer) => {
      out += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      out += chunk.toString("utf8");
    });
    child.on("error", () => {
      if (!terminating) done(false);
    });
    child.on("exit", () => {
      if (!terminating) done(/(?:^|\s)-i(?:,|\s)|--image\b/.test(out));
    });
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
    let finishTrace: (result?: AgentRunResult, error?: unknown) => void = () => {};
    let progress = initialAgentProgress(adapter.kind);
    let progressTimer: ReturnType<typeof setTimeout> | undefined;
    let lastProgressReportAt = 0;
    const publishProgress = () => {
      if (progressTimer) clearTimeout(progressTimer);
      progressTimer = undefined;
      lastProgressReportAt = Date.now();
      try {
        opts.onProgress?.({
          ...progress,
          recentEvents: progress.recentEvents?.map((event) => ({ ...event })),
        });
      } catch {
        // Observation must never stop the underlying CLI.
      }
    };
    const observeOutput = (data: unknown) => {
      if (!opts.onProgress) return;
      progress = advanceAgentProgressWith(progress, adapter.kind, data);
      const delay = 250 - (Date.now() - lastProgressReportAt);
      if (delay <= 0) publishProgress();
      else progressTimer ??= setTimeout(publishProgress, delay);
    };
    const flushProgress = () => {
      if (progressTimer) publishProgress();
    };
    void (async () => {
      throwIfAborted(signal);
      publishProgress();
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
        additionalReadDirs: opts.additionalReadDirs,
        codexImageInputSupported,
      });
      throwIfAborted(signal);
      // claude takes the prompt in argv (`-p <prompt>`) and wants stdin closed
      // (verified: avoids a 3s wait). codex `exec` reads the prompt from stdin
      // (argv ends with `-`), so adapters that set promptViaStdin get a piped
      // stdin we write the prompt to.
      const viaStdin = adapter.promptViaStdin === true;
      const child = spawn(opts.command, args, {
        cwd: opts.cwd,
        env: { ...process.env, PATH: pathWithCommonBins() },
        // Keep the agent in the owning worker/app process group. If that owner
        // is force-terminated, the CLI and its descendants must not escape into
        // a detached group that can keep editing the workspace unseen.
        detached: false,
        stdio: [viaStdin ? "pipe" : "ignore", "pipe", "pipe"],
      });
      if (child.pid) {
        try {
          opts.onProcess?.(child.pid);
        } catch {
          // Process observation is best-effort metadata, like onSessionId.
        }
      }
      const common = {
        provider: adapter.kind,
        model: opts.model ?? "CLI default",
        source: `drive-agent-${adapter.kind}-cli`,
        purpose: "external_delegation",
        startedAt: Date.now(),
      };
      const initialTrace = recordExternalModelCall({
        ...common,
        status: "running",
        input: {
          messages: [{ role: "user", content: opts.prompt }],
          parameters: {
            cliArguments: args,
            promptViaStdin: viaStdin,
            launchCwd: opts.cwd,
            resumeExternalSessionId: opts.resumeSessionId,
            imagePaths: opts.imagePaths,
            additionalReadDirs: opts.additionalReadDirs,
            limitation:
              "CLI entry input and visible final result only; private model requests, retries, and provider usage are opaque.",
          },
        },
      });
      let traceFinished = false;
      finishTrace = (result, error) => {
        if (!initialTrace || traceFinished) return;
        traceFinished = true;
        const status = signal?.aborted
          ? "cancelled"
          : error || result?.isError || result?.exitCode !== 0
            ? "failed"
            : "completed";
        const captured = initialTrace.inputState !== "not-recorded";
        recordExternalModelCall({
          ...common,
          id: initialTrace.id,
          status,
          endedAt: Date.now(),
          output: captured && result ? { text: result.finalText, stopReason: status } : undefined,
          error: error
            ? captured
              ? String(error instanceof Error ? error.message : error)
              : "External CLI request failed"
            : undefined,
        });
      };
      let reportedSessionId = "";
      const reportSessionId = (candidate: unknown): void => {
        if (reportedSessionId || typeof candidate !== "string" || !candidate.trim()) return;
        reportedSessionId = candidate.trim();
        try {
          opts.onSessionId?.(reportedSessionId);
        } catch {
          // Session observation is best-effort metadata. A UI/persistence
          // listener must never be able to fail the external agent run.
        }
      };
      reportSessionId(opts.resumeSessionId);
      let settled = false;
      let abortRequested = false;
      let termination: Promise<void> | undefined;
      const cleanup = () => {
        signal?.removeEventListener("abort", onAbort);
        flushProgress();
      };
      const onAbort = () => {
        if (abortRequested) return;
        abortRequested = true;
        termination = terminateAttachedProcessTree(child);
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) onAbort();
      if (viaStdin && child.stdin) {
        child.stdin.end(opts.prompt);
      }
      const lines: string[] = [];
      if (child.stdout) {
        const rl = createInterface({ input: child.stdout });
        rl.on("line", (line) => {
          if (!line.trim()) {
            lines.push(line);
            return;
          }
          let data: unknown;
          try {
            data = JSON.parse(line);
          } catch {
            // Non-JSON stdout still proves activity; the legacy result parser
            // keeps its own handling of the raw line below.
          }
          if (!settled) observeOutput(data);
          // Complete assistant/result records are authoritative for the final
          // result. Keeping every partial token as well duplicates large runs
          // in memory and retains reasoning deltas that the UI never needs.
          const partialMessage =
            adapter.kind === "claude" &&
            (data as { type?: unknown } | null | undefined)?.type === "stream_event";
          if (!partialMessage) lines.push(line);
          if (!reportedSessionId) {
            try {
              reportSessionId(adapter.parseResult([line]).sessionId);
            } catch {
              // Keep collecting output. The complete parse at exit remains the
              // source of truth and will surface malformed output normally.
            }
          }
        });
      }
      // Drain diagnostics so a full stderr pipe cannot stall an otherwise live
      // CLI. Only its receipt is activity; stderr text never enters UI status.
      child.stderr?.on("data", () => {
        if (!settled) observeOutput(undefined);
      });
      child.on("error", (err) => {
        if (settled) return;
        settled = true;
        cleanup();
        finishTrace(undefined, err);
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
      // exit can arrive before the final stdout/stderr data events. close
      // ensures the result and final activity snapshot include those bytes;
      // a grandchild holding the pipes only delays it by the grace period.
      child.once("exit", () => {
        const timer = setTimeout(() => {
          child.stdout?.destroy();
          child.stderr?.destroy();
          child.stdin?.destroy();
        }, STDIO_RELEASE_GRACE_MS);
        timer.unref?.();
        child.once("close", () => clearTimeout(timer));
      });
      child.on("close", (code) => {
        if (settled) return;
        settled = true;
        cleanup();
        void (termination ?? Promise.resolve())
          .then(() => {
            const result = runWithLines(adapter, lines, code);
            finishTrace(result);
            reportSessionId(result.sessionId);
            resolve(result);
          })
          .catch((error) => {
            finishTrace(undefined, error);
            reject(error);
          });
      });
    })().catch((error) => {
      flushProgress();
      finishTrace(undefined, error);
      reject(error);
    });
  });
}
