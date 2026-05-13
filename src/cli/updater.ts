/**
 * Auto-update — checks npm registry for newer versions; can optionally install
 * the new version in the background after the current process exits.
 *
 * Flow:
 *   1. `checkForUpdate()` runs at startup (non-blocking). Stores result in
 *      module state for the UI to read via `getUpdateAvailable()`.
 *   2. UI re-polls every 30 min via `pollForUpdate()`.
 *   3. If the user has write permission on the npm global prefix, we register
 *      `scheduleAutoInstallOnExit()` so that on process exit a detached
 *      `npm i -g` spawns and survives the parent. Next startup picks up
 *      the new version.
 *   4. If the user has NO permission, UI shows the manual command instead.
 *
 * Concurrency: multiple `code-shell` processes can run at once. A file lock
 * at `~/.code-shell/.update.lock` prevents both from launching `npm i -g`
 * simultaneously (which corrupts the install).
 *
 * Headless safety: `checkForUpdate()` and `scheduleAutoInstallOnExit()` are
 * only invoked from the Ink-based UpdateBanner component, never from the
 * `run` / `arena` headless code paths. Keep it that way — wiring the updater
 * into bare CLI commands would surprise CI users with background `npm i -g`
 * on every short-lived `code-shell run …` invocation. If you need updater
 * behavior in a new headless entry point, gate it on something explicit
 * (e.g. `--auto-update` flag) rather than calling it unconditionally.
 */

import { execFile, spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, mkdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { gt } from "../utils/semver.js";

const execFileAsync = promisify(execFile);

const PACKAGE_NAME = "@cjhyy/code-shell";
const LOCK_FILE = ".update.lock";
const LOCK_TIMEOUT_MS = 5 * 60 * 1000; // 5 min — stale-lock takeover threshold
const NPM_VIEW_TIMEOUT_MS = 5_000;

export interface UpdateInfo {
  latestVersion: string;
  /** True if `<npm prefix>` is writable by current user — can self-install. */
  canAutoInstall: boolean;
  /** Cached npm global prefix path (for diagnostics / manual command hint). */
  npmPrefix: string | null;
}

let _updateInfo: UpdateInfo | undefined;
let _exitHookInstalled = false;
let _disabledReason: string | null = null;

// ─── Public API ────────────────────────────────────────────────────────

/**
 * Kick off an update check. Non-blocking: returns immediately, fills module
 * state when network/npm respond. Safe to call multiple times (e.g. on a 30min
 * timer).
 */
export function checkForUpdate(packageName = PACKAGE_NAME): void {
  void runCheck(packageName);
}

/** Returns update info if a newer version was found, else undefined. */
export function getUpdateAvailable(): UpdateInfo | undefined {
  return _updateInfo;
}

/** Returns "why is auto-update off" — for /doctor-style diagnostics. */
export function getAutoUpdateDisabledReason(): string | null {
  return _disabledReason;
}

/**
 * Install the on-exit hook so that the new version is installed AFTER the
 * current process exits (avoids overwriting files the running process still
 * has open). Idempotent — calling twice is a no-op.
 */
export function scheduleAutoInstallOnExit(): void {
  if (_exitHookInstalled) return;
  _exitHookInstalled = true;

  const fire = () => {
    const info = _updateInfo;
    if (!info || !info.canAutoInstall) return;
    // Best-effort: spawn and forget. Errors logged to ~/.code-shell/update.log.
    try {
      launchDetachedInstall(info.latestVersion);
    } catch {
      // intentionally swallowed — we're in process.exit
    }
  };

  process.once("exit", fire);
}

// ─── Version detection ─────────────────────────────────────────────────

let _cachedVersion: string | undefined;

export function getCurrentVersion(): string {
  if (_cachedVersion) return _cachedVersion;
  const found = resolveVersion();
  _cachedVersion = found;
  return found;
}

function resolveVersion(): string {
  // Walk up from this module until we find a package.json with a "version" field.
  // Works in ESM and CJS builds, and in dev (bun src).
  try {
    const here = typeof import.meta !== "undefined" && import.meta.url
      ? dirname(fileURLToPath(import.meta.url))
      : __dirname;
    let dir = here;
    for (let i = 0; i < 6; i++) {
      try {
        const pkg = JSON.parse(readFileSync(resolve(dir, "package.json"), "utf-8"));
        if (pkg && typeof pkg.version === "string") return pkg.version;
      } catch {
        // not here, walk up
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    // fall through
  }
  try {
    const req = createRequire(import.meta.url ?? __filename);
    const pkg = req("../../package.json");
    if (pkg?.version) return pkg.version as string;
  } catch {
    // ignore
  }
  return "0.0.0";
}

// ─── Check logic ───────────────────────────────────────────────────────

async function runCheck(packageName: string): Promise<void> {
  const disabled = isAutoUpdaterDisabled();
  if (disabled) {
    _disabledReason = disabled;
    return;
  }
  _disabledReason = null;

  try {
    const currentVersion = getCurrentVersion();
    const latestVersion = await getLatestVersion(packageName);
    if (!latestVersion) return;

    // Compare with real semver — handles 1.0.0-alpha.3 < 1.0.0 correctly.
    // gt() throws on invalid input; guard with try.
    let isNewer = false;
    try {
      isNewer = gt(latestVersion, currentVersion);
    } catch {
      // Fall back to strict-string-inequality for non-semver build SHAs.
      isNewer = latestVersion !== currentVersion;
    }
    if (!isNewer) {
      _updateInfo = undefined;
      return;
    }

    const { hasPermissions, npmPrefix } = await checkGlobalInstallPermissions();
    _updateInfo = { latestVersion, canAutoInstall: hasPermissions, npmPrefix };
  } catch {
    // Network down, npm not installed, etc. — silently leave _updateInfo as-is.
  }
}

async function getLatestVersion(packageName: string): Promise<string | null> {
  // Run from $HOME so a malicious project-level .npmrc cannot redirect us
  // to an attacker's registry.
  try {
    const { stdout } = await execFileAsync(
      "npm",
      ["view", `${packageName}@latest`, "version", "--prefer-online"],
      { cwd: homedir(), timeout: NPM_VIEW_TIMEOUT_MS },
    );
    const v = stdout.trim();
    return v.length > 0 ? v : null;
  } catch {
    return null;
  }
}

// ─── Permission probe ──────────────────────────────────────────────────

async function checkGlobalInstallPermissions(): Promise<{
  hasPermissions: boolean;
  npmPrefix: string | null;
}> {
  let prefix: string | null = null;
  try {
    const { stdout } = await execFileAsync(
      "npm",
      ["-g", "config", "get", "prefix"],
      { cwd: homedir(), timeout: 5_000 },
    );
    prefix = stdout.trim();
  } catch {
    return { hasPermissions: false, npmPrefix: null };
  }
  if (!prefix) return { hasPermissions: false, npmPrefix: null };

  try {
    await access(prefix, fsConstants.W_OK);
    return { hasPermissions: true, npmPrefix: prefix };
  } catch {
    return { hasPermissions: false, npmPrefix: prefix };
  }
}

// ─── Lock + install ────────────────────────────────────────────────────

function userHome(): string {
  return process.env.HOME ?? homedir();
}

function configDir(): string {
  return join(userHome(), ".code-shell");
}

function getLockFilePath(): string {
  return join(configDir(), LOCK_FILE);
}

function getUpdateLogPath(): string {
  return join(configDir(), "update.log");
}

/**
 * Try to acquire the update lock. Returns true on success.
 * Uses `O_EXCL` (writeFile flag 'wx') for atomic create. Stale locks (mtime
 * older than LOCK_TIMEOUT_MS) are taken over, re-verifying staleness right
 * before unlink to close the TOCTOU race.
 */
async function acquireLock(): Promise<boolean> {
  const lockPath = getLockFilePath();
  try {
    const s = await stat(lockPath);
    if (Date.now() - s.mtimeMs < LOCK_TIMEOUT_MS) return false;
    // Stale — verify again, then unlink.
    try {
      const recheck = await stat(lockPath);
      if (Date.now() - recheck.mtimeMs < LOCK_TIMEOUT_MS) return false;
      await unlink(lockPath);
    } catch (err) {
      if (!isENOENT(err)) return false;
    }
  } catch (err) {
    if (!isENOENT(err)) return false;
    // ENOENT: no lock, proceed to create.
  }

  try {
    await writeFile(lockPath, String(process.pid), { encoding: "utf8", flag: "wx" });
    return true;
  } catch (err) {
    const code = errnoCode(err);
    if (code === "EEXIST") return false;
    if (code === "ENOENT") {
      try {
        await mkdir(configDir(), { recursive: true });
        await writeFile(lockPath, String(process.pid), { encoding: "utf8", flag: "wx" });
        return true;
      } catch {
        return false;
      }
    }
    return false;
  }
}

async function releaseLock(): Promise<void> {
  const lockPath = getLockFilePath();
  try {
    const data = await readFile(lockPath, "utf8");
    if (data === String(process.pid)) await unlink(lockPath);
  } catch {
    // ENOENT or someone else holds it — leave alone
  }
}

/**
 * Spawn `npm i -g <pkg>@<version>` detached so it survives our exit. We can't
 * await it (we're inside process.exit handler) — we only acquire the lock
 * synchronously-ish and let the child do its thing.
 *
 * The child writes to ~/.code-shell/update.log so users can diagnose failures.
 */
function launchDetachedInstall(version: string): void {
  const lockPath = getLockFilePath();
  // Synchronous best-effort lock: writeFileSync with 'wx'. If another process
  // already holds it, give up silently — they'll do the install.
  try {
    // Avoid `mkdirSync recursive` failures if dir exists.
    try {
      const fs = require("node:fs") as typeof import("node:fs");
      fs.mkdirSync(configDir(), { recursive: true });
      fs.writeFileSync(lockPath, String(process.pid), { encoding: "utf8", flag: "wx" });
    } catch (err) {
      if (errnoCode(err) === "EEXIST") {
        // Lock held — check freshness; if stale, take over.
        try {
          const fs = require("node:fs") as typeof import("node:fs");
          const s = fs.statSync(lockPath);
          if (Date.now() - s.mtimeMs < LOCK_TIMEOUT_MS) return; // fresh — back off
          fs.unlinkSync(lockPath);
          fs.writeFileSync(lockPath, String(process.pid), { encoding: "utf8", flag: "wx" });
        } catch {
          return;
        }
      } else {
        return;
      }
    }
  } catch {
    return;
  }

  const fs = require("node:fs") as typeof import("node:fs");
  const logFd = fs.openSync(getUpdateLogPath(), "a");
  try {
    fs.writeSync(
      logFd,
      `\n[${new Date().toISOString()}] code-shell auto-update: installing ${PACKAGE_NAME}@${version} (pid=${process.pid})\n`,
    );
  } catch {
    // ignore
  }

  // Wrap install + lock cleanup in a tiny shell so the lock file is removed
  // even if npm fails. `-c` style runs as a single child, detached from us.
  const cmd = [
    `npm install -g ${PACKAGE_NAME}@${shellEscape(version)}`,
    `; rm -f ${shellEscape(lockPath)}`,
  ].join(" ");

  try {
    const child = spawn("sh", ["-c", cmd], {
      detached: true,
      stdio: ["ignore", logFd, logFd],
      cwd: homedir(),
    });
    child.unref();
  } catch {
    // If spawn itself fails, free the lock so the next run can try.
    try {
      fs.unlinkSync(lockPath);
    } catch {
      // ignore
    }
  }
}

// ─── Disabled-reason resolution ────────────────────────────────────────

/**
 * Returns a human-readable reason if auto-update is disabled, else null.
 * Checked in order:
 *   1. NODE_ENV=development
 *   2. DISABLE_AUTOUPDATER env var (truthy)
 *   3. settings.autoUpdates === false
 */
function isAutoUpdaterDisabled(): string | null {
  if (process.env.NODE_ENV === "development") return "development build";
  if (isEnvTruthy(process.env.DISABLE_AUTOUPDATER)) return "DISABLE_AUTOUPDATER set";
  // Best-effort: read user settings.json directly. Avoids pulling in the
  // SettingsManager (and its zod validation) just to read one flag, and dodges
  // the circular-import risk between settings/ and cli/.
  if (readAutoUpdatesFlagFromDisk() === false) return "settings.autoUpdates = false";
  return null;
}

/**
 * Read `autoUpdates` from the user settings file. Returns undefined if the
 * file is missing/unreadable or the key isn't set (caller treats undefined as
 * "default on"). Checks ~/.code-shell first, then ~/.claude as a fallback —
 * matches what SettingsManager loads at user scope.
 */
function readAutoUpdatesFlagFromDisk(): boolean | undefined {
  // ~/.code-shell/ only — Claude Code compat path was dropped from settings
  // loading (their `model` field is a string, ours is an object).
  const path = join(userHome(), ".code-shell", "settings.json");
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (typeof parsed.autoUpdates === "boolean") return parsed.autoUpdates;
  } catch {
    // missing / invalid JSON / wrong type — fall through to undefined
  }
  return undefined;
}

function isEnvTruthy(v: string | undefined): boolean {
  if (!v) return false;
  const lower = v.toLowerCase();
  return lower === "1" || lower === "true" || lower === "yes" || lower === "on";
}

// ─── Helpers ───────────────────────────────────────────────────────────

function errnoCode(err: unknown): string | undefined {
  return typeof err === "object" && err !== null && "code" in err
    ? String((err as { code?: unknown }).code)
    : undefined;
}

function isENOENT(err: unknown): boolean {
  return errnoCode(err) === "ENOENT";
}

function shellEscape(s: string): string {
  // Quote-and-escape for `sh -c`. Acceptable since `version` comes from npm.
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

// Re-export the lock release for tests / shutdown paths if needed.
export const __internal = { acquireLock, releaseLock, getLockFilePath };
