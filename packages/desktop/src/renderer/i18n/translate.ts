import type { UILanguage } from "../uiLanguage";
import { messages as defaultMessages, type Messages, type TranslationKey } from "./dict";

export type TranslateParams = Record<string, string | number>;

/** Walk a dotted key path (`"a.b.c"`) into a nested object; return the string leaf or undefined. */
function lookup(tree: unknown, key: string): string | undefined {
  let node: unknown = tree;
  for (const part of key.split(".")) {
    if (node == null || typeof node !== "object") return undefined;
    node = (node as Record<string, unknown>)[part];
  }
  return typeof node === "string" ? node : undefined;
}

/** Replace `{name}` placeholders with values from `params`; leaves unknown placeholders intact. */
function interpolate(text: string, params?: TranslateParams): string {
  if (!params) return text;
  return text.replace(/\{(\w+)\}/g, (whole, name: string) =>
    name in params ? String(params[name]) : whole,
  );
}

/**
 * Resolve a translation key for `lang`. Fallback chain:
 *   1. the requested language,
 *   2. Chinese (zh) — the source-of-truth tree,
 *   3. the raw key string itself (so missing keys are visible, never blank).
 * Then `{name}`-style placeholders are interpolated.
 *
 * Pure & React-free so it can be unit-tested with `bun test`.
 */
export function translate(
  lang: UILanguage,
  key: TranslationKey | string,
  params?: TranslateParams,
  dict: Messages = defaultMessages,
): string {
  const hit = lookup(dict[lang], key) ?? lookup(dict.zh, key) ?? key;
  return interpolate(hit, params);
}
