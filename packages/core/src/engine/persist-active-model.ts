import type { ModelEntry } from "../llm/model-pool.js";
import type { SettingsManager } from "../settings/manager.js";
import { logger } from "../logging/logger.js";

/**
 * Write the active model selection to ~/.code-shell/settings.json.
 *
 * Persists settings.defaults.text = entry.key (the connection id == pool
 * key). That is the single field the boot path reads to restore the active
 * text model on the next startup (see ctor: settings.defaults.text → pool
 * switch). No legacy activeKey/model.* mirror is written.
 */
export function persistActiveModel(entry: ModelEntry, settings: SettingsManager): void {
  try {
    // Reuse the Engine's manager so every settings writer shares the directory
    // lock, selected JSON/YAML layer, validation and cache invalidation.
    settings.saveUserSetting("defaults.text", entry.key);
  } catch (err) {
    logger.warn(`persistActiveModel failed: ${(err as Error).message}`);
  }
}
