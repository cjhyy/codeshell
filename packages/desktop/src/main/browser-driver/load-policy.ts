/**
 * Load the browser-automation policy from user settings.json, synchronously
 * with a short cache (the automation host reads it per action via a sync
 * getter). Reads only the small `browserAutomation` block; defaults to the
 * permissive policy (empty whitelist = allow all) when unset/unreadable.
 *
 * Settings shape: { "browserAutomation": { "allowedDomains": ["xiaohongshu.com", ".example.com"] } }
 */

import { readFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DEFAULT_POLICY, type BrowserAutomationPolicy } from "./policy.js";

let cached: { value: BrowserAutomationPolicy; at: number } | null = null;
const TTL_MS = 5_000;

function settingsPath(): string {
  return path.join(os.homedir(), ".code-shell", "settings.json");
}

export function loadBrowserAutomationPolicy(): BrowserAutomationPolicy {
  const now = Date.now();
  if (cached && now - cached.at < TTL_MS) return cached.value;
  let value: BrowserAutomationPolicy = DEFAULT_POLICY;
  try {
    const raw = readFileSync(settingsPath(), "utf8");
    const json = JSON.parse(raw) as Record<string, unknown>;
    const ba = json.browserAutomation as { allowedDomains?: unknown } | undefined;
    if (ba && Array.isArray(ba.allowedDomains)) {
      value = { allowedDomains: ba.allowedDomains.filter((d): d is string => typeof d === "string") };
    }
  } catch {
    /* ENOENT / parse error → permissive default */
  }
  cached = { value, at: now };
  return value;
}

/** Test helper: drop the cache so a changed settings file is re-read. */
export function _resetPolicyCache(): void {
  cached = null;
}
