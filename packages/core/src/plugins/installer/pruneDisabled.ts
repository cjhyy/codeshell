/**
 * Prune a plugin's orphaned entries from a settings object's `disabledSkills`
 * (entries shaped `name:skill`) and `disabledPlugins` (bare `name`). Called on
 * uninstall so a removed plugin leaves no dangling disable flags behind.
 *
 * Pure + immutable: returns a NEW object (shallow clone) with the two arrays
 * replaced by filtered copies. Settings lacking these fields pass through
 * unchanged. A plugin name that is a prefix of another (`mimi-video` vs
 * `mimi-video-pro`) only matches its own exact name / `name:` prefix.
 */

import { writeFileSync, mkdirSync, existsSync, readFileSync, renameSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

/**
 * Resolve the user's home dir, preferring `process.env.HOME` so HOME-isolated
 * tests (and runtime overrides) take effect — same contract as
 * SettingsManager.userHome and installer/paths.ts, without dragging in the
 * settings module's heavier transitive deps.
 */
function userHome(): string {
  return process.env.HOME ?? homedir();
}

export interface PrunableSettings {
  disabledSkills?: string[];
  disabledPlugins?: string[];
  [key: string]: unknown;
}

export function pruneDisabledEntriesForPlugin<T extends PrunableSettings>(
  settings: T,
  pluginName: string,
): T {
  const skillPrefix = `${pluginName}:`;
  const out: PrunableSettings = { ...settings };
  if (Array.isArray(settings.disabledSkills)) {
    out.disabledSkills = settings.disabledSkills.filter(
      (s) => !s.startsWith(skillPrefix),
    );
  }
  if (Array.isArray(settings.disabledPlugins)) {
    out.disabledPlugins = settings.disabledPlugins.filter((p) => p !== pluginName);
  }
  return out as T;
}

/**
 * Read the user settings.json (under {@link userHome}, so HOME-isolated tests
 * are honored), prune the plugin's orphaned disable entries, and write back —
 * only when something actually changed. Never throws: a missing/corrupt file or
 * any IO error is swallowed (uninstall already succeeded; settings cleanup is
 * best-effort). Atomic write via .tmp + rename mirrors SettingsManager.
 */
export function pruneDisabledSettingsForPlugin(pluginName: string): void {
  try {
    const path = join(userHome(), ".code-shell", "settings.json");
    if (!existsSync(path)) return;
    let current: PrunableSettings;
    try {
      const parsed = JSON.parse(readFileSync(path, "utf-8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
      current = parsed as PrunableSettings;
    } catch {
      return; // corrupt file — leave it alone
    }
    const pruned = pruneDisabledEntriesForPlugin(current, pluginName);
    const changed =
      JSON.stringify(pruned.disabledSkills) !== JSON.stringify(current.disabledSkills) ||
      JSON.stringify(pruned.disabledPlugins) !== JSON.stringify(current.disabledPlugins);
    if (!changed) return;
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
    // mode 0o600 — settings.json can hold plaintext API keys, so the pruned
    // rewrite must stay owner-only (matching settings/manager.ts), not fall back
    // to the umask default 0o644 (world-readable). The tmp IS the final file
    // after renameSync, so the mode must be set at create time, not via chmod.
    writeFileSync(tmp, JSON.stringify(pruned, null, 2), { encoding: "utf-8", mode: 0o600 });
    renameSync(tmp, path);
  } catch {
    // best-effort cleanup — never fail the uninstall over settings IO
  }
}
