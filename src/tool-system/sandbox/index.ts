/**
 * Sandbox backends for shell command execution.
 *
 * We wrap Bash-tool commands in an OS-level sandbox so a misbehaving (or
 * prompt-injected) model can't reach beyond the workspace. The sandbox runs
 * the user's command inside an isolated process tree with restricted file
 * and (optionally) network access. The Engine itself is NOT sandboxed; only
 * the spawned shell is. File-editing tools (Edit/Write) keep going through
 * the application-layer permission gate.
 *
 * Backends are platform-specific:
 *   - "seatbelt"  macOS sandbox-exec, built into macOS, zero install
 *   - "bwrap"     Linux bubblewrap, requires `apt install bubblewrap`
 *   - "off"       passthrough, no sandboxing (current behavior)
 *
 * "auto" picks per platform at startup; falls back to "off" with a warning
 * when no sandbox is available.
 */

import { accessSync, constants, realpathSync } from "node:fs";
import { homedir } from "node:os";

export type SandboxMode = "off" | "auto" | "seatbelt" | "bwrap";
export type SandboxNetworkPolicy = "allow" | "deny";

export interface SandboxConfig {
  mode: SandboxMode;
  writableRoots: string[];
  deniedReads: string[];
  network: SandboxNetworkPolicy;
}

export interface SandboxBackend {
  /** Resolved backend name — "off" means no sandboxing. */
  name: "off" | "seatbelt" | "bwrap";
  /**
   * Decide the binary + argv that should actually be spawned to run `command`
   * under this sandbox. The shell still interprets `command`; we only swap
   * the outer process.
   */
  wrap(
    command: string,
    opts: { cwd: string; shell: string },
  ): {
    file: string;
    args: string[];
    /**
     * Optional callback the Bash tool calls after the child process exits.
     * Backends that allocate per-command resources (e.g. seatbelt writes a
     * profile file to a fresh temp dir) hang their cleanup here so a long
     * session doesn't leak hundreds of temp dirs in /tmp.
     */
    cleanup?: () => void;
  };
  /**
   * If `stderr` looks like a sandbox denial, return a short hint string that
   * the Bash tool will append to its result so the model understands why.
   */
  hintForBlockedOutput?(stderr: string): string | undefined;
}

/**
 * Detect which sandbox mechanisms are available on the current host. Used by
 * "auto" mode and surfaced to the user via /sandbox status if desired.
 */
export function detectSandboxCapabilities(): {
  seatbelt: boolean;
  bwrap: boolean;
} {
  return {
    seatbelt: process.platform === "darwin" && binaryExists("/usr/bin/sandbox-exec"),
    bwrap: process.platform === "linux" && (binaryExists("/usr/bin/bwrap") || binaryExists("/usr/local/bin/bwrap")),
  };
}

function binaryExists(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Expand `~` and `${workspace}` placeholders against the live cwd and home.
 */
export function expandPath(p: string, cwd: string): string {
  if (p === "${workspace}") return cwd;
  if (p.startsWith("${workspace}/")) return cwd + p.slice("${workspace}".length);
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return homedir() + p.slice(1);
  return p;
}

/**
 * Resolve a path through any symlinks. On macOS `/var` and `/tmp` are
 * symlinks to `/private/var` and `/private/tmp`; Seatbelt's `subpath` rules
 * match by canonical (post-resolution) path, so a profile that lists
 * `/var/folders/...` silently doesn't match when the syscall actually
 * hits `/private/var/folders/...`. Resolving up front fixes this.
 *
 * Falls back to the original path when realpath fails (e.g. the path
 * doesn't exist yet — common for deniedReads on hosts without those
 * credential dirs).
 */
function canonicalize(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

export function expandConfig(config: SandboxConfig, cwd: string): SandboxConfig {
  return {
    ...config,
    writableRoots: config.writableRoots.map((p) => canonicalize(expandPath(p, cwd))),
    deniedReads: config.deniedReads.map((p) => canonicalize(expandPath(p, cwd))),
  };
}

/**
 * Default config when the user hasn't supplied anything. Workspace +
 * /tmp writable; ssh / cloud creds explicitly denied for read; network
 * left open (sandboxing network breaks `npm install`, `git pull`, etc.,
 * and most users find that surprising).
 */
/**
 * Emit a one-shot warning when `auto` finds no usable backend. Per-process
 * latch so a long REPL session doesn't repeat the message every Engine run.
 * Suppressible with CODE_SHELL_SANDBOX_QUIET=1 for users who know.
 */
let autoDowngradeWarned = false;
function warnAutoDowngrade(): void {
  if (autoDowngradeWarned) return;
  if (process.env.CODE_SHELL_SANDBOX_QUIET === "1") return;
  autoDowngradeWarned = true;
  const platform = process.platform;
  let hint: string;
  if (platform === "linux") {
    hint = "install bubblewrap (apt install bubblewrap / dnf install bubblewrap)";
  } else if (platform === "win32") {
    hint = "run code-shell inside WSL or a Docker container";
  } else {
    hint = "this platform does not currently have an OS-level sandbox backend";
  }
  process.stderr.write(
    `[code-shell] sandbox=auto found no usable backend; shell commands will run unsandboxed. To fix: ${hint}. ` +
      `Set sandbox.mode=off in settings.json to silence, or CODE_SHELL_SANDBOX_QUIET=1.\n`,
  );
}

export function defaultSandboxConfig(mode: SandboxMode = "auto"): SandboxConfig {
  return {
    mode,
    writableRoots: ["${workspace}", "/tmp", "/private/tmp", "/var/tmp"],
    deniedReads: [
      "~/.ssh",
      "~/.aws",
      "~/.config/gcloud",
      "~/.code-shell",
      "~/.claude",
    ],
    network: "allow",
  };
}

/**
 * Resolve the active backend given user config + the current host.
 *
 *   "off"      → off backend
 *   "seatbelt" → seatbelt if available, else throws (explicit choice)
 *   "bwrap"    → bwrap if available, else throws
 *   "auto"     → seatbelt on macOS, bwrap on Linux with bwrap installed,
 *                else off + console warning
 */
export async function resolveSandboxBackend(
  config: SandboxConfig,
  cwd: string,
): Promise<SandboxBackend> {
  const expanded = expandConfig(config, cwd);
  const caps = detectSandboxCapabilities();

  let chosen: "off" | "seatbelt" | "bwrap";
  switch (config.mode) {
    case "off":
      chosen = "off";
      break;
    case "seatbelt":
      if (!caps.seatbelt) {
        throw new Error(
          "sandbox.mode=seatbelt requested but sandbox-exec is unavailable (macOS-only). " +
            'Set sandbox.mode to "auto" or "off".',
        );
      }
      chosen = "seatbelt";
      break;
    case "bwrap":
      if (!caps.bwrap) {
        throw new Error(
          "sandbox.mode=bwrap requested but bubblewrap (bwrap) is not installed. " +
            "Install with `apt install bubblewrap` (Debian/Ubuntu) or `dnf install bubblewrap` (Fedora).",
        );
      }
      chosen = "bwrap";
      break;
    case "auto":
      if (caps.seatbelt) chosen = "seatbelt";
      else if (caps.bwrap) chosen = "bwrap";
      else {
        chosen = "off";
        warnAutoDowngrade();
      }
      break;
  }

  switch (chosen) {
    case "off": {
      const { createOffBackend } = await import("./off.js");
      return createOffBackend();
    }
    case "seatbelt": {
      const { createSeatbeltBackend } = await import("./seatbelt.js");
      // Same footgun as bwrap below: seatbelt's `(subpath "...")` rule for
      // a non-existent path silently matches nothing, so a typo in
      // writableRoots presents as "my sandbox blocks all writes" with no
      // diagnostic. Warn so the user notices the dropped path up front.
      warnMissingWritableRoots(expanded.writableRoots);
      return createSeatbeltBackend(expanded);
    }
    case "bwrap": {
      const { createBwrapBackend } = await import("./bwrap.js");
      // bwrap's --bind-try silently skips paths that don't exist on the
      // host. That's the right default (e.g. /private/tmp doesn't exist on
      // Linux) but turns into invisible footguns for typos: a user adds
      // "/work/important" to writableRoots, mistypes it as "/wrok/...", and
      // every write looks blocked-by-sandbox with no diagnostic. Warn here
      // so the user sees the path got dropped before the first command.
      warnMissingWritableRoots(expanded.writableRoots);
      return createBwrapBackend(expanded);
    }
  }
}

/**
 * Warn once per session for each writableRoot that doesn't exist on the
 * host. Keyed by absolute path so a long session doesn't repeat the same
 * warning across many Engine.run() calls.
 */
const missingWritableWarned = new Set<string>();
function warnMissingWritableRoots(roots: string[]): void {
  if (process.env.CODE_SHELL_SANDBOX_QUIET === "1") return;
  for (const root of roots) {
    if (missingWritableWarned.has(root)) continue;
    let exists = false;
    try {
      accessSync(root, constants.F_OK);
      exists = true;
    } catch {
      // doesn't exist
    }
    if (!exists) {
      missingWritableWarned.add(root);
      process.stderr.write(
        `[code-shell] sandbox.writableRoots includes "${root}" which doesn't exist on this host — ` +
          `writes there will be blocked. Check for typos in settings.json (silence with CODE_SHELL_SANDBOX_QUIET=1).\n`,
      );
    }
  }
}
