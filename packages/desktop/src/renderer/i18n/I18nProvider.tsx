import React from "react";
import { loadUILanguage, type UILanguage } from "../uiLanguage";
import { translate, type TranslateParams } from "./translate";
import type { TranslationKey } from "./dict";

/** `t(key, params?)` resolves a typed translation key for the active language. */
export type TFunction = (key: TranslationKey, params?: TranslateParams) => string;

interface I18nContextValue {
  lang: UILanguage;
  t: TFunction;
}

const I18nContext = React.createContext<I18nContextValue | null>(null);

/**
 * Provides the active UI language + a bound `t()` to the React tree.
 *
 * The language initialises from `loadUILanguage()` (localStorage) and re-reads
 * whenever `saveUILanguage()` broadcasts the `codeshell:language-changed`
 * window event, so a language switch anywhere re-renders consumers. Mount this
 * at the very top of the provider stack (above DialogProvider) in `main.tsx`.
 */
export function I18nProvider({ children }: { children: React.ReactNode }) {
  const [lang, setLang] = React.useState<UILanguage>(() => loadUILanguage());

  React.useEffect(() => {
    const onChange = () => setLang(loadUILanguage());
    window.addEventListener("codeshell:language-changed", onChange);
    return () => window.removeEventListener("codeshell:language-changed", onChange);
  }, []);

  const value = React.useMemo<I18nContextValue>(
    () => ({
      lang,
      t: (key, params) => translate(lang, key, params),
    }),
    [lang],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

/**
 * Read the active language and the bound `t()` translator.
 *
 * Usage:
 *   const { t, lang } = useT();
 *   t("common.cancel");                 // typed key
 *   t("greeting.hello", { name: "Ada" }) // with interpolation
 */
export function useT(): I18nContextValue {
  const ctx = React.useContext(I18nContext);
  // Fallback when rendered outside a provider (e.g. unit tests that mount a
  // single card via renderToStaticMarkup, or any stray render before the
  // provider mounts): translate against the stored / default language directly
  // so components stay usable instead of throwing.
  if (!ctx) {
    let lang: UILanguage = "zh";
    try {
      lang = loadUILanguage();
    } catch {
      // No localStorage (e.g. SSR-style unit test) — default to Chinese.
    }
    return { lang, t: (key, params) => translate(lang, key, params) };
  }
  return ctx;
}
