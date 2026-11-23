/** Native Electron menus follow the system locale, including before any renderer opens. */
export function nativeMenuLanguage(locale: string): "zh" | "en" {
  return locale.toLowerCase().startsWith("zh") ? "zh" : "en";
}
