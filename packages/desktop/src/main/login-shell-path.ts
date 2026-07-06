import { spawn } from "node:child_process";
import { delimiter } from "node:path";

const DEFAULT_TIMEOUT_MS = 2_500;
const MAX_CAPTURE_BYTES = 64 * 1024;

type SupportedPlatform = NodeJS.Platform;

export type LoginShellPathProbeResult =
  | { ok: true; shell: string; path: string }
  | {
      ok: false;
      shell?: string;
      reason: "unsupported-platform" | "no-shell" | "spawn-error" | "timeout" | "exit" | "no-path";
      code?: number | null;
      signal?: NodeJS.Signals | null;
      error?: string;
      stderr?: string;
    };

export type LoginShellPathInjectionResult =
  | { status: "skipped"; reason: "unsupported-platform" | "no-shell" }
  | {
      status: "unchanged";
      reason: "probe-failed" | "already-current";
      probe: LoginShellPathProbeResult;
    }
  | {
      status: "updated";
      before: string;
      after: string;
      added: string[];
      probe: Extract<LoginShellPathProbeResult, { ok: true }>;
    };

export function splitPathEntries(
  pathValue: string | undefined,
  pathDelimiter = delimiter,
): string[] {
  return (pathValue ?? "")
    .split(pathDelimiter)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

/**
 * Merge a login-shell PATH into the current GUI PATH without dropping existing
 * entries.
 *
 * Existing PATH order stays intact; missing login-shell entries are prepended
 * in login order so Homebrew/user bins become visible before a stripped
 * /usr/bin:/bin GUI PATH. Running this repeatedly is idempotent.
 */
export function mergeLoginShellPath(
  existingPath: string | undefined,
  loginShellPath: string | undefined,
  pathDelimiter = delimiter,
): string {
  const existingEntries: string[] = [];
  const seen = new Set<string>();
  const addExisting = (entry: string) => {
    if (!entry || seen.has(entry)) return;
    seen.add(entry);
    existingEntries.push(entry);
  };

  for (const entry of splitPathEntries(existingPath, pathDelimiter)) addExisting(entry);

  const missingLoginEntries: string[] = [];
  for (const entry of splitPathEntries(loginShellPath, pathDelimiter)) {
    if (seen.has(entry)) continue;
    seen.add(entry);
    missingLoginEntries.push(entry);
  }

  return [...missingLoginEntries, ...existingEntries].join(pathDelimiter);
}

export function parseEnvPathOutput(output: string): string | null {
  let found: string | null = null;
  for (const line of output.split(/\r?\n/)) {
    if (line.startsWith("PATH=")) found = line.slice("PATH=".length);
  }
  return found && found.trim() ? found.trim() : null;
}

function defaultShellForPlatform(platform: SupportedPlatform): string | null {
  if (platform === "darwin") return "/bin/zsh";
  if (platform === "linux") return "/bin/bash";
  return null;
}

export function resolveLoginShell(
  env: NodeJS.ProcessEnv = process.env,
  platform: SupportedPlatform = process.platform,
): string | null {
  if (platform !== "darwin" && platform !== "linux") return null;
  return env.SHELL?.trim() || defaultShellForPlatform(platform);
}

export async function probeLoginShellPath(
  options: {
    env?: NodeJS.ProcessEnv;
    platform?: SupportedPlatform;
    shell?: string | null;
    timeoutMs?: number;
  } = {},
): Promise<LoginShellPathProbeResult> {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  if (platform !== "darwin" && platform !== "linux") {
    return { ok: false, reason: "unsupported-platform" };
  }

  const shell = options.shell ?? resolveLoginShell(env, platform);
  if (!shell) return { ok: false, reason: "no-shell" };

  return await new Promise<LoginShellPathProbeResult>((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timeout: NodeJS.Timeout | undefined;
    const finish = (result: LoginShellPathProbeResult) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      resolve(result);
    };

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(shell, ["-lic", "env"], {
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      finish({
        ok: false,
        shell,
        reason: "spawn-error",
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    timeout = setTimeout(() => {
      try {
        child.kill("SIGTERM");
      } catch {
        // Best effort; the caller keeps startup moving regardless.
      }
      finish({ ok: false, shell, reason: "timeout", stderr: stderr.trim() || undefined });
    }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);

    child.stdout?.on("data", (chunk: Buffer) => {
      if (stdout.length >= MAX_CAPTURE_BYTES) return;
      stdout += chunk.toString("utf8", 0, Math.max(0, MAX_CAPTURE_BYTES - stdout.length));
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderr.length >= MAX_CAPTURE_BYTES) return;
      stderr += chunk.toString("utf8", 0, Math.max(0, MAX_CAPTURE_BYTES - stderr.length));
    });
    child.on("error", (err) => {
      finish({ ok: false, shell, reason: "spawn-error", error: err.message });
    });
    child.on("close", (code, signal) => {
      const path = parseEnvPathOutput(stdout);
      if (code === 0 && path) {
        finish({ ok: true, shell, path });
        return;
      }
      finish({
        ok: false,
        shell,
        reason: path ? "exit" : "no-path",
        code,
        signal,
        stderr: stderr.trim() || undefined,
      });
    });
  });
}

export async function injectLoginShellPathAtStartup(
  options: {
    env?: NodeJS.ProcessEnv;
    platform?: SupportedPlatform;
    timeoutMs?: number;
    log?: (event: string, data?: Record<string, unknown>) => void;
  } = {},
): Promise<LoginShellPathInjectionResult> {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  if (platform !== "darwin" && platform !== "linux") {
    return { status: "skipped", reason: "unsupported-platform" };
  }

  const shell = resolveLoginShell(env, platform);
  if (!shell) return { status: "skipped", reason: "no-shell" };

  const before = env.PATH ?? "";
  const probe = await probeLoginShellPath({
    env,
    platform,
    shell,
    timeoutMs: options.timeoutMs,
  });

  if (!probe.ok) {
    options.log?.("login-shell-path.failed", {
      shell,
      reason: probe.reason,
      error: probe.error,
      code: probe.code,
      signal: probe.signal,
      stderr: probe.stderr,
    });
    return { status: "unchanged", reason: "probe-failed", probe };
  }

  const after = mergeLoginShellPath(before, probe.path);
  if (!after || after === before) {
    options.log?.("login-shell-path.unchanged", { shell, reason: "already-current" });
    return { status: "unchanged", reason: "already-current", probe };
  }

  const beforeEntries = new Set(splitPathEntries(before));
  const added = splitPathEntries(after).filter((entry) => !beforeEntries.has(entry));
  env.PATH = after;
  options.log?.("login-shell-path.updated", {
    shell,
    added,
    before,
    after,
  });
  return { status: "updated", before, after, added, probe };
}
