export type UILanguage = "zh" | "en";

const KEY = "codeshell.uiLanguage";

/** Read the stored UI language preference. Defaults to Chinese. */
export function loadUILanguage(): UILanguage {
  const raw = localStorage.getItem(KEY);
  if (raw === "zh" || raw === "en") return raw;
  return "zh";
}

/**
 * Persist the UI language preference and broadcast a change event so
 * any listeners can react. This only records the preference — actual
 * UI string translation (i18n) is a separate, future effort.
 */
export function saveUILanguage(lang: UILanguage): void {
  localStorage.setItem(KEY, lang);
  window.dispatchEvent(new Event("codeshell:language-changed"));
}

/** Human label for a language, shown in the language switcher. */
export function languageLabel(lang: UILanguage): string {
  return lang === "zh" ? "中文" : "English";
}
