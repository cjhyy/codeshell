export type UILanguage = "zh" | "en";

export const UI_LANGUAGE_STORAGE_KEY = "codeshell.uiLanguage";

/** Read the stored UI language preference. Defaults to Chinese.
 * Guards against environments with no localStorage (node tests, non-DOM
 * callers) — translate() reaches here via helpers like bgCompletionText, so a
 * bare localStorage access would throw "localStorage is not defined". */
export function loadUILanguage(): UILanguage {
  try {
    const raw = globalThis.localStorage?.getItem(UI_LANGUAGE_STORAGE_KEY);
    if (raw === "zh" || raw === "en") return raw;
  } catch {
    /* no localStorage (node/test) → fall through to default */
  }
  return "zh";
}

/**
 * Persist the UI language preference and broadcast a change event so
 * any listeners can react. This only records the preference — actual
 * UI string translation (i18n) is a separate, future effort.
 */
export function saveUILanguage(lang: UILanguage): void {
  try {
    globalThis.localStorage?.setItem(UI_LANGUAGE_STORAGE_KEY, lang);
    globalThis.dispatchEvent?.(new Event("codeshell:language-changed"));
  } catch {
    /* no localStorage/DOM (node/test) — preference just isn't persisted */
  }
}

/** Human label for a language, shown in the language switcher. */
export function languageLabel(lang: UILanguage): string {
  return lang === "zh" ? "中文" : "English";
}
