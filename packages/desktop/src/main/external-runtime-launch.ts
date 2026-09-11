import { stat } from "node:fs/promises";
import { findOnPath } from "./external-runtime-availability.js";
import { injectLoginShellPathAtStartup } from "./login-shell-path.js";
import { dlog } from "./desktop-logger.js";

const REFRESH_TIMEOUT_MS = 5_000;
const REFRESH_COOLDOWN_MS = 30_000;

export interface CodexLaunch {
  command: string;
  env: NodeJS.ProcessEnv;
}

interface CodexLaunchResolverOptions {
  env?: NodeJS.ProcessEnv;
  refreshEnvironment?: () => Promise<unknown>;
  now?: () => number;
  log?: (event: string, data: Record<string, unknown>) => void;
}

/**
 * Resolve before reserving a session or opening its tool bridge. Discovery and
 * launch use the same executable check; launch pins its absolute command and
 * environment together. A failed GUI shell probe gets one bounded retry here,
 * never a replay of a provider request or an agent turn.
 */
export function createCodexLaunchResolver(options: CodexLaunchResolverOptions = {}) {
  const env = options.env ?? process.env;
  const now = options.now ?? Date.now;
  const log = options.log ?? ((event, data) => dlog("external-runtime", event, data));
  const refresh =
    options.refreshEnvironment ??
    (() =>
      injectLoginShellPathAtStartup({
        env,
        timeoutMs: REFRESH_TIMEOUT_MS,
        phase: "runtime-retry",
        log: (event, data) => log(event, data ?? {}),
      }));
  let pendingRefresh: Promise<void> | undefined;
  let retryAfter = 0;

  return async (cwd: string): Promise<CodexLaunch> => {
    // ENOENT from spawn conflates a missing program with a missing cwd. Keep
    // these separate while the host still knows what it is preparing.
    try {
      if (!(await stat(cwd)).isDirectory()) {
        throw Object.assign(new Error("not a directory"), { code: "ENOTDIR" });
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? "UNKNOWN";
      log("launch.cwd_unavailable", { runtime: "codex", code });
      throw new Error(
        `Codex cannot start: working directory is unavailable (${code}): ` +
          `${JSON.stringify(cwd.slice(0, 300))}. Reopen an existing project folder and retry.`,
        { cause: error },
      );
    }

    let command = findOnPath("codex", env.PATH);
    let source = "current-path";
    if (!command) {
      // Concurrent windows share the same refresh. A repeatedly missing CLI
      // cannot spawn a login shell on every click; every call still reprobes
      // PATH, so a newly installed executable is immediately usable.
      if (!pendingRefresh && now() >= retryAfter) {
        pendingRefresh = Promise.resolve().then(async () => {
          const startedAt = now();
          log("launch.environment_refresh", { runtime: "codex" });
          try {
            await refresh();
          } catch (error) {
            log("launch.environment_refresh_failed", {
              runtime: "codex",
              error: error instanceof Error ? error.name : "unknown",
            });
          } finally {
            retryAfter = now() + REFRESH_COOLDOWN_MS;
            pendingRefresh = undefined;
            log("launch.environment_refresh_finished", {
              runtime: "codex",
              elapsedMs: Math.max(0, now() - startedAt),
            });
          }
        });
      }
      if (pendingRefresh) await pendingRefresh;
      command = findOnPath("codex", env.PATH);
      source = "refreshed-path";
    }

    if (!command) {
      log("launch.executable_missing", { runtime: "codex", phase: "preflight" });
      throw new Error(
        "Codex CLI was not found in CodeShell's executable search path after checking the " +
          "shell environment. Check that `codex --version` works in your terminal, then " +
          "retry. No agent turn was started.",
      );
    }

    log("launch.executable_resolved", { runtime: "codex", source });
    return { command, env: { ...env } };
  };
}
