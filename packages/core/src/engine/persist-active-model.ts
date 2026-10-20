import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ModelEntry } from "../llm/model-pool.js";
import { userHome } from "../settings/manager.js";
import { logger } from "../logging/logger.js";

/**
 * Write the active model selection to ~/.code-shell/settings.json.
 *
 * Persists settings.defaults.text = entry.key (the connection id == pool
 * key). That is the single field the boot path reads to restore the active
 * text model on the next startup (see ctor: settings.defaults.text → pool
 * switch). No legacy activeKey/model.* mirror is written.
 */
export function persistActiveModel(entry: ModelEntry): void {
  try {
    // userHome() (not raw homedir()) so a test that sets process.env.HOME to
    // a tmpdir gets its writes isolated too — the SettingsManager reader
    // already honors HOME; the writer must match or tests pollute the real
    // ~/.code-shell/settings.json (this happened: an A-key/model-a leak).
    const dir = join(userHome(), ".code-shell");
    const file = join(dir, "settings.json");
    mkdirSync(dir, { recursive: true });

    let existing: Record<string, unknown> = {};
    if (existsSync(file)) {
      try {
        existing = JSON.parse(readFileSync(file, "utf-8"));
      } catch {
        // corrupt file — bail rather than clobber the user's config
        return;
      }
    }

    const prevDefaults =
      typeof existing.defaults === "object" && existing.defaults
        ? (existing.defaults as Record<string, unknown>)
        : {};
    const updated: Record<string, unknown> = {
      ...existing,
      defaults: { ...prevDefaults, text: entry.key },
    };

    // mode 0o600: this writes model.apiKey (plaintext) into settings.json, so
    // it must be owner-only — same R-1 hardening as SettingsManager/onboarding.
    // (Third settings.json writer; the R-1 sweep initially missed this one.)
    const tmp = `${file}.${process.pid}.tmp`;
    const payload = JSON.stringify(updated, null, 2) + "\n";
    writeFileSync(tmp, payload, { encoding: "utf-8", mode: 0o600 });
    try {
      renameSync(tmp, file);
    } catch {
      writeFileSync(file, payload, { encoding: "utf-8", mode: 0o600 });
    }
    // mode arg only applies on create; tighten an already-existing file too.
    try {
      chmodSync(file, 0o600);
    } catch {
      /* best-effort */
    }
  } catch (err) {
    logger.warn(`persistActiveModel failed: ${(err as Error).message}`);
  }
}
