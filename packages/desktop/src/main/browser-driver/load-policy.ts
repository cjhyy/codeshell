/**
 * Load the browser-automation policy from user settings.json, synchronously
 * with a short cache (the automation host reads it per action via a sync
 * getter). Reads only the small `browserAutomation` block; defaults to the
 * permissive policy (empty whitelist = allow all) when unset/unreadable.
 *
 * Settings shape: { "browserAutomation": { "allowedDomains": ["xiaohongshu.com", ".example.com"] } }
 * A missing file keeps the local user-present default; an existing malformed
 * policy fails closed so corruption cannot silently disable a whitelist.
 */

import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
} from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DEFAULT_POLICY, DENY_ALL_POLICY, type BrowserAutomationPolicy } from "./policy.js";

let cached: { value: BrowserAutomationPolicy; at: number } | null = null;
const TTL_MS = 5_000;
const MAX_SETTINGS_BYTES = 4 * 1024 * 1024;
const MAX_ALLOWED_DOMAINS = 1_000;
let settingsPathOverride: string | null = null;

function settingsPath(): string {
  return settingsPathOverride ?? path.join(os.homedir(), ".code-shell", "settings.json");
}

export function loadBrowserAutomationPolicy(): BrowserAutomationPolicy {
  const now = Date.now();
  if (cached && now - cached.at < TTL_MS) return cached.value;
  let value: BrowserAutomationPolicy = DEFAULT_POLICY;
  let fd: number | undefined;
  try {
    const target = settingsPath();
    const entry = lstatSync(target);
    if (entry.isSymbolicLink() || !entry.isFile() || entry.size > MAX_SETTINGS_BYTES) {
      throw new Error("settings file is unsafe");
    }
    fd = openSync(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.size > MAX_SETTINGS_BYTES) {
      throw new Error("settings file is unsafe");
    }
    const json = JSON.parse(readFileSync(fd, "utf8")) as unknown;
    if (!json || typeof json !== "object" || Array.isArray(json)) {
      throw new Error("settings root is invalid");
    }
    const ba = (json as Record<string, unknown>).browserAutomation;
    if (ba !== undefined) value = parseBrowserAutomationPolicy(ba);
  } catch (error) {
    // A genuinely absent file means the user has not enabled a whitelist.
    // Existing-but-unreadable/malformed policy must not silently allow every
    // site, because that defeats an explicitly configured security boundary.
    value = (error as NodeJS.ErrnoException).code === "ENOENT" ? DEFAULT_POLICY : DENY_ALL_POLICY;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  cached = { value, at: now };
  return value;
}

/** Test helper: drop the cache so a changed settings file is re-read. */
export function _resetPolicyCache(): void {
  cached = null;
}

export function _setPolicySettingsPathForTest(next: string | null): void {
  settingsPathOverride = next;
  cached = null;
}

function parseBrowserAutomationPolicy(value: unknown): BrowserAutomationPolicy {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("browser automation policy is invalid");
  }
  const domains = (value as Record<string, unknown>).allowedDomains;
  if (!Array.isArray(domains) || domains.length > MAX_ALLOWED_DOMAINS) {
    throw new Error("browser automation allowedDomains is invalid");
  }
  const normalized = domains.map(normalizeDomainPattern);
  if (normalized.some((domain) => domain === null)) {
    throw new Error("browser automation domain pattern is invalid");
  }
  return { allowedDomains: normalized as string[] };
}

function normalizeDomainPattern(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().toLowerCase();
  const suffix = trimmed.startsWith(".");
  const bare = suffix ? trimmed.slice(1) : trimmed;
  if (!bare || bare.length > 253 || /[\s\0/:?#@]/u.test(bare)) return null;
  try {
    const hostname = new URL(`https://${bare}`).hostname.toLowerCase();
    if (!hostname || hostname.includes(":")) return null;
    return suffix ? `.${hostname}` : hostname;
  } catch {
    return null;
  }
}
