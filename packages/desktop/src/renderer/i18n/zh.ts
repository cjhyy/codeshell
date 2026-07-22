/**
 * Chinese translations — the default/fallback language.
 *
 * Keys are the original Chinese strings. The value is the same string
 * (identity). We still provide a map so the lookup logic is symmetric,
 * but in practice `t(key)` returns `key` when `lang === "zh"` and the
 * key is not in any dictionary — so this file can stay empty.
 *
 * Entries here are only needed when the source string has changed but
 * we want to keep the old translation for backward compatibility.
 */
export const zh: Record<string, string> = {};
