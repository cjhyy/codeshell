/**
 * Self-contained i18n for the web client logic layer.
 *
 * The dictionary is the `mobile` namespace (moved here from the desktop
 * renderer's `i18n/ns/mobile.ts`; the renderer still spreads it into its own
 * dict, so desktop `useT("mobile.*")` keys keep working). `lookup` /
 * `interpolate` / the zh-fallback chain mirror the renderer's `translate.ts`
 * exactly so a string renders identically on desktop and on the phone.
 */
import type { UILanguage } from "../lib/uiLanguage.js";
import { loadUILanguage } from "../lib/uiLanguage.js";
import { mobile } from "./mobile.js";

/** Web-package dictionary: just the `mobile` namespace (zh is source of truth). */
export const webMessages = mobile;

type Dict = Record<string, unknown>;
type DottedKeys<T extends Dict, Prefix extends string = ""> = {
  [K in keyof T & string]: T[K] extends Dict ? DottedKeys<T[K], `${Prefix}${K}.`> : `${Prefix}${K}`;
}[keyof T & string];

/** Type-safe union of every translation key in the web dict. */
export type WebTranslationKey = DottedKeys<typeof webMessages.zh>;

export type WebTranslateParams = Record<string, string | number>;

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
function interpolate(text: string, params?: WebTranslateParams): string {
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
 */
export function translate(
  lang: UILanguage,
  key: WebTranslationKey | string,
  params?: WebTranslateParams,
): string {
  const hit = lookup(webMessages[lang], key) ?? lookup(webMessages.zh, key) ?? key;
  return interpolate(hit, params);
}

/** Translate with the persisted UI language (localStorage; defaults to zh). */
export function t(key: WebTranslationKey | string, params?: WebTranslateParams): string {
  return translate(loadUILanguage(), key, params);
}
