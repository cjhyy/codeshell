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

import { join } from "node:path";
import { homedir } from "node:os";
import { mutateJsonFile } from "../../utils/file-mutex.js";

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
    out.disabledSkills = settings.disabledSkills.filter((s) => !s.startsWith(skillPrefix));
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
 * best-effort). The read and atomic rewrite share SettingsManager's directory
 * lock so a concurrent settings update cannot be lost.
 */
export function pruneDisabledSettingsForPlugin(pluginName: string): void {
  try {
    const path = join(userHome(), ".code-shell", "settings.json");
    mutateJsonFile<PrunableSettings | undefined>(path, {
      parse: (raw) => {
        if (raw === undefined) return undefined;
        try {
          const parsed = JSON.parse(raw);
          return parsed && typeof parsed === "object" && !Array.isArray(parsed)
            ? (parsed as PrunableSettings)
            : undefined;
        } catch {
          return undefined;
        }
      },
      serialize: (settings) => JSON.stringify(settings, null, 2),
      mutation: (current) => {
        if (current === undefined) return {};
        const pruned = pruneDisabledEntriesForPlugin(current, pluginName);
        const changed =
          JSON.stringify(pruned.disabledSkills) !== JSON.stringify(current.disabledSkills) ||
          JSON.stringify(pruned.disabledPlugins) !== JSON.stringify(current.disabledPlugins);
        return changed ? { value: pruned } : {};
      },
      // Settings may hold plaintext API keys; the renamed file stays owner-only.
      mode: 0o600,
    });
  } catch {
    // best-effort cleanup — never fail the uninstall over settings IO
  }
}
