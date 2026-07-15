/**
 * Shim — the UI-language preference (type + localStorage load/save) moved to
 * @cjhyy/code-shell-web so the browser client logic layer can read it without
 * depending on the renderer. Re-exported here so the renderer's many
 * `@/uiLanguage` imports keep working unchanged.
 */
export {
  loadUILanguage,
  saveUILanguage,
  languageLabel,
  UI_LANGUAGE_STORAGE_KEY,
  type UILanguage,
} from "@cjhyy/code-shell-web";
