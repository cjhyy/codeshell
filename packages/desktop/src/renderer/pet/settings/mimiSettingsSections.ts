/**
 * The sections of the Mimi settings page, in navigation order. The page is
 * separate from the global settings center; the center links into it.
 */
export const MIMI_SETTINGS_SECTIONS = [
  "appearance",
  "conversation",
  "notifications",
  "rules",
  "memory",
  "connections",
] as const;

export type MimiSettingsSection = (typeof MIMI_SETTINGS_SECTIONS)[number];

export const DEFAULT_MIMI_SETTINGS_SECTION: MimiSettingsSection = "appearance";

const LAST_SECTION_KEY = "codeshell:mimi-settings:section";

export function isMimiSettingsSection(value: unknown): value is MimiSettingsSection {
  return (MIMI_SETTINGS_SECTIONS as readonly unknown[]).includes(value);
}

/** The section the owner last looked at; a per-viewer convenience only. */
export function loadMimiSettingsSection(): MimiSettingsSection {
  try {
    const stored = globalThis.localStorage?.getItem(LAST_SECTION_KEY);
    return isMimiSettingsSection(stored) ? stored : DEFAULT_MIMI_SETTINGS_SECTION;
  } catch {
    return DEFAULT_MIMI_SETTINGS_SECTION;
  }
}

export function saveMimiSettingsSection(section: MimiSettingsSection): void {
  try {
    globalThis.localStorage?.setItem(LAST_SECTION_KEY, section);
  } catch {
    // Storage can be disabled; the section still works for this visit.
  }
}
