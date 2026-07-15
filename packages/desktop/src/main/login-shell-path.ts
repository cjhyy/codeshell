import { spawn } from "node:child_process";
import { delimiter } from "node:path";
import { ENV_DENY_REGEX } from "@cjhyy/code-shell-core/internal";

const DEFAULT_TIMEOUT_MS = 2_500;
const MAX_CAPTURE_BYTES = 64 * 1024;
const LOGIN_SHELL_ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const LOGIN_SHELL_ENV_SYSTEM_KEYS = new Set([
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "PWD",
  "OLDPWD",
  "SHLVL",
  "_",
  "TMPDIR",
  "SSH_AUTH_SOCK",
  "COMMAND_MODE",
  "MallocNanoZone",
]);
const LOGIN_SHELL_ENV_SYSTEM_PREFIXES = ["XPC_", "__CF"];

function redactedStderrLogFields(stderr: string | undefined): Record<string, unknown> {
  if (!stderr) return {};
  return {
    stderrRedacted: true,
    stderrLength: stderr.length,
  };
}

type SupportedPlatform = NodeJS.Platform;

export type LoginShellPathProbeResult =
  | { ok: true; shell: string; path: string; env?: Record<string, string> }
  | {
      ok: false;
      shell?: string;
      reason: "unsupported-platform" | "no-shell" | "spawn-error" | "timeout" | "exit" | "no-path";
      code?: number | null;
      signal?: NodeJS.Signals | null;
      error?: string;
      stderr?: string;
    };

type LoginShellEnvInjectionBase = { addedEnvKeys: string[] };

export type LoginShellPathInjectionResult =
  | ({
      status: "skipped";
      reason: "unsupported-platform" | "no-shell";
    } & LoginShellEnvInjectionBase)
  | {
      status: "unchanged";
      reason: "probe-failed" | "already-current";
      probe: LoginShellPathProbeResult;
    } & LoginShellEnvInjectionBase
  | {
      status: "updated";
      before: string;
      after: string;
      added: string[];
      probe: Extract<LoginShellPathProbeResult, { ok: true }>;
    } & LoginShellEnvInjectionBase;

export type LoginShellEnvMergeResult = {
  path: string;
  addedPathEntries: string[];
  addedEnv: Record<string, string>;
  addedEnvKeys: string[];
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

export function parseLoginShellEnvOutput(output: string): Record<string, string> {
  const parsed: Record<string, string> = {};
  for (const line of output.split(/\r?\n/)) {
    const separatorIndex = line.indexOf("=");
    if (separatorIndex <= 0) continue;
    const key = line.slice(0, separatorIndex);
    if (!LOGIN_SHELL_ENV_NAME_PATTERN.test(key)) continue;
    parsed[key] = line.slice(separatorIndex + 1);
  }
  return parsed;
}

export function parseEnvPathOutput(output: string): string | null {
  let found: string | null = null;
  for (const line of output.split(/\r?\n/)) {
    if (line.startsWith("PATH=")) found = line.slice("PATH=".length);
  }
  return found && found.trim() ? found.trim() : null;
}

function isLoginShellSystemEnvKey(key: string): boolean {
  if (LOGIN_SHELL_ENV_SYSTEM_KEYS.has(key)) return true;
  return LOGIN_SHELL_ENV_SYSTEM_PREFIXES.some((prefix) => key.startsWith(prefix));
}

function shouldInjectLoginShellEnvKey(key: string, current: NodeJS.ProcessEnv): boolean {
  if (!LOGIN_SHELL_ENV_NAME_PATTERN.test(key)) return false;
  if (key === "PATH") return false;
  if (ENV_DENY_REGEX.test(key)) return false;
  if (isLoginShellSystemEnvKey(key)) return false;
  if (current[key] !== undefined) return false;
  return true;
}

export function mergeLoginShellEnv(
  current: NodeJS.ProcessEnv,
  snapshot: Record<string, string>,
  pathDelimiter = delimiter,
): LoginShellEnvMergeResult {
  const currentPath = current.PATH ?? "";
  const path = mergeLoginShellPath(currentPath, snapshot.PATH, pathDelimiter);
  const currentPathEntries = new Set(splitPathEntries(currentPath, pathDelimiter));
  const addedPathEntries = splitPathEntries(path, pathDelimiter).filter(
    (entry) => !currentPathEntries.has(entry),
  );
  const addedEnv: Record<string, string> = {};

  for (const key of Object.keys(snapshot).sort()) {
    if (!shouldInjectLoginShellEnvKey(key, current)) continue;
    addedEnv[key] = snapshot[key];
  }

  return {
    path,
    addedPathEntries,
    addedEnv,
    addedEnvKeys: Object.keys(addedEnv),
  };
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
      const envSnapshot = parseLoginShellEnvOutput(stdout);
      const path = parseEnvPathOutput(stdout);
      if (code === 0 && path) {
        finish({ ok: true, shell, path, env: { ...envSnapshot, PATH: path } });
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
    return { status: "skipped", reason: "unsupported-platform", addedEnvKeys: [] };
  }

  const shell = resolveLoginShell(env, platform);
  if (!shell) return { status: "skipped", reason: "no-shell", addedEnvKeys: [] };

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
      ...redactedStderrLogFields(probe.stderr),
    });
    return { status: "unchanged", reason: "probe-failed", probe, addedEnvKeys: [] };
  }

  const merge = mergeLoginShellEnv(env, { ...(probe.env ?? {}), PATH: probe.path });
  const after = merge.path;
  if (!after || (after === before && merge.addedEnvKeys.length === 0)) {
    options.log?.("login-shell-path.unchanged", {
      shell,
      reason: "already-current",
      addedEnvKeys: [],
    });
    return { status: "unchanged", reason: "already-current", probe, addedEnvKeys: [] };
  }

  if (after !== before) env.PATH = after;
  for (const key of merge.addedEnvKeys) env[key] = merge.addedEnv[key];
  options.log?.("login-shell-path.updated", {
    shell,
    pathChanged: after !== before,
    addedPathEntryCount: merge.addedPathEntries.length,
    addedEnvKeys: merge.addedEnvKeys,
  });
  return {
    status: "updated",
    before,
    after,
    added: merge.addedPathEntries,
    addedEnvKeys: merge.addedEnvKeys,
    probe,
  };
}
