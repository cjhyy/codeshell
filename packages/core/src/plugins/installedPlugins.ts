/**
 * Read/write ~/.code-shell/plugins/installed_plugins.json (V2 format).
 * Reads the Claude Code-compatible V2 shape plus optional CodeShell integrity
 * fields on each install entry.
 */

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import type { InstalledPluginsV2, PluginInstallEntry, StoredPluginHookReview } from "./types.js";

const MAX_PLUGIN_KEYS = 2_048;
const MAX_INSTALLS_PER_KEY = 16;
const MAX_KEY_LENGTH = 256;
const MAX_PATH_LENGTH = 4_096;
const MAX_METADATA_LENGTH = 512;
const DIGEST_RE = /^[a-f0-9]{64}$/;
const MAX_HOOK_REVIEW_ITEMS = 256;
const MAX_HOOK_REVIEW_COMMAND_LENGTH = 4_096;
const MAX_HOOK_REVIEW_MATCHER_LENGTH = 4_096;

function userHome(): string {
  return process.env.HOME ?? homedir();
}

export function installedPluginsPath(): string {
  return join(userHome(), ".code-shell", "plugins", "installed_plugins.json");
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function boundedString(value: unknown, maxLength: number): string | undefined {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= maxLength &&
    !value.includes("\0")
    ? value
    : undefined;
}

function hookReviewItemOf(value: unknown): StoredPluginHookReview | undefined {
  const raw = recordOf(value);
  if (!raw) return undefined;
  const rawEvent = boundedString(raw.rawEvent, 128);
  const command = boundedString(raw.command, MAX_HOOK_REVIEW_COMMAND_LENGTH);
  const commandDigest =
    typeof raw.commandDigest === "string" && DIGEST_RE.test(raw.commandDigest)
      ? raw.commandDigest
      : undefined;
  if (!rawEvent || !command || !commandDigest) return undefined;
  const matcher =
    raw.matcher === undefined
      ? undefined
      : boundedString(raw.matcher, MAX_HOOK_REVIEW_MATCHER_LENGTH);
  if (raw.matcher !== undefined && matcher === undefined) return undefined;
  if (raw.commandTruncated !== undefined && typeof raw.commandTruncated !== "boolean") {
    return undefined;
  }
  if (raw.async !== undefined && typeof raw.async !== "boolean") return undefined;
  const timeoutMs =
    raw.timeoutMs === undefined ||
    (typeof raw.timeoutMs === "number" &&
      Number.isSafeInteger(raw.timeoutMs) &&
      raw.timeoutMs >= 1 &&
      raw.timeoutMs <= 600_000)
      ? (raw.timeoutMs as number | undefined)
      : null;
  if (timeoutMs === null) return undefined;
  return {
    rawEvent,
    ...(matcher === undefined ? {} : { matcher }),
    command,
    commandDigest,
    ...(raw.commandTruncated === true ? { commandTruncated: true } : {}),
    ...(raw.async === undefined ? {} : { async: raw.async }),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  };
}

function installEntryOf(value: unknown): PluginInstallEntry | undefined {
  const raw = recordOf(value);
  if (!raw || raw.scope !== "user") return undefined;
  const installPath = boundedString(raw.installPath, MAX_PATH_LENGTH);
  const version = boundedString(raw.version, MAX_METADATA_LENGTH);
  const installedAt = boundedString(raw.installedAt, MAX_METADATA_LENGTH);
  const lastUpdated = boundedString(raw.lastUpdated, MAX_METADATA_LENGTH);
  if (!installPath || !version || !installedAt || !lastUpdated) return undefined;

  const entry: PluginInstallEntry = {
    scope: "user",
    installPath,
    version,
    installedAt,
    lastUpdated,
  };
  const gitCommitSha = boundedString(raw.gitCommitSha, MAX_METADATA_LENGTH);
  if (gitCommitSha) entry.gitCommitSha = gitCommitSha;
  for (const field of [
    "hookDigest",
    "approvedHookDigest",
    "mcpDigest",
    "approvedMcpDigest",
  ] as const) {
    const digest = raw[field];
    if (typeof digest === "string" && DIGEST_RE.test(digest)) entry[field] = digest;
  }
  if (
    Array.isArray(raw.approvedHookSnapshot) &&
    raw.approvedHookSnapshot.length <= MAX_HOOK_REVIEW_ITEMS
  ) {
    const snapshot = raw.approvedHookSnapshot
      .map((item) => hookReviewItemOf(item))
      .filter((item): item is StoredPluginHookReview => item !== undefined);
    if (snapshot.length === raw.approvedHookSnapshot.length) entry.approvedHookSnapshot = snapshot;
  }
  return entry;
}

function registryOf(value: unknown): InstalledPluginsV2 | undefined {
  const raw = recordOf(value);
  const plugins = recordOf(raw?.plugins);
  if (raw?.version !== 2 || !plugins) return undefined;
  const entries = Object.entries(plugins);
  if (entries.length > MAX_PLUGIN_KEYS) return undefined;

  const normalized: InstalledPluginsV2 = { version: 2, plugins: {} };
  for (const [key, value] of entries) {
    if (
      key.length === 0 ||
      key.length > MAX_KEY_LENGTH ||
      key.includes("\0") ||
      !Array.isArray(value) ||
      value.length > MAX_INSTALLS_PER_KEY
    ) {
      continue;
    }
    const installs = value
      .map((entry) => installEntryOf(entry))
      .filter((entry): entry is PluginInstallEntry => entry !== undefined);
    if (installs.length > 0) normalized.plugins[key] = installs;
  }
  return normalized;
}

export function readInstalledPlugins(): InstalledPluginsV2 {
  const path = installedPluginsPath();
  if (!existsSync(path)) return { version: 2, plugins: {} };
  try {
    const parsed = registryOf(JSON.parse(readFileSync(path, "utf-8")));
    if (parsed) return parsed;
  } catch {
    // Corrupt — treat as empty so the user can re-install.
  }
  return { version: 2, plugins: {} };
}

export function writeInstalledPlugins(data: InstalledPluginsV2): void {
  const path = installedPluginsPath();
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", {
      encoding: "utf-8",
      flag: "wx",
      mode: 0o600,
    });
    renameSync(tmp, path);
  } finally {
    rmSync(tmp, { force: true });
  }
}

/**
 * Append an install entry for `<plugin>@<marketplace>`. Multiple entries
 * for the same key are allowed (different scopes); MVP only writes scope:"user".
 */
export function appendInstallEntry(key: string, entry: PluginInstallEntry): void {
  const data = readInstalledPlugins();
  const list = data.plugins[key] ?? [];
  list.push(entry);
  data.plugins[key] = list;
  writeInstalledPlugins(data);
}

export function removeInstallEntries(key: string): boolean {
  const data = readInstalledPlugins();
  if (!(key in data.plugins)) return false;
  delete data.plugins[key];
  writeInstalledPlugins(data);
  return true;
}

export function pluginInstallKey(plugin: string, marketplace: string): string {
  return `${plugin}@${marketplace}`;
}
