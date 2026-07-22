/**
 * Minimal i18n infrastructure — no third-party deps.
 *
 * Design: source strings (Chinese) are used as lookup keys. In zh mode
 * `t("新对话")` returns `"新对话"` (the key itself). In en mode it looks
 * up the English dictionary and returns `"New Chat"`. If a key isn't in
 * the English dictionary, it falls back to the key (Chinese) — so
 * unmigrated components are unaffected.
 *
 * Usage in components:
 *   const { t } = useTranslation();
 *   <span>{t("新对话")}</span>
 *
 * For strings with interpolation, use $0, $1, … as placeholders:
 *   t("已在 ${0} 中构建", repoName)
 */

import React, {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  type ReactNode,
} from "react";
import { loadUILanguage, saveUILanguage, type UILanguage } from "../uiLanguage";
import { en as enDict } from "./en";
import { zh as zhDict } from "./zh";

type Dict = Record<string, string>;

const DICTS: Record<UILanguage, Dict> = {
  zh: zhDict,
  en: enDict,
};

interface I18nContextValue {
  /** Current language code. */
  lang: UILanguage;
  /** Switch language (persists to localStorage, broadcasts event). */
  setLang: (lang: UILanguage) => void;
  /** Translate a source string. Extra args replace $0, $1, … */
  t: (key: string, ...args: (string | number)[]) => string;
}

const I18nContext = createContext<I18nContextValue | null>(null);

export function LanguageProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<UILanguage>(() => loadUILanguage());

  // Re-sync when another component (e.g. SettingsMenu) changes the language.
  useEffect(() => {
    const handler = (): void => setLangState(loadUILanguage());
    window.addEventListener("codeshell:language-changed", handler);
    return () => window.removeEventListener("codeshell:language-changed", handler);
  }, []);

  const setLang = useCallback((next: UILanguage): void => {
    saveUILanguage(next);
    setLangState(next);
  }, []);

  const t = useCallback(
    (key: string, ...args: (string | number)[]): string => {
      const dict = DICTS[lang];
      let result = dict[key] ?? key;
      // Replace $0, $1, $2, … with positional args
      for (let i = 0; i < args.length; i++) {
        result = result.replace(`\${${i}}`, String(args[i]));
      }
      return result;
    },
    [lang],
  );

  return (
    <I18nContext.Provider value={{ lang, setLang, t }}>
      {children}
    </I18nContext.Provider>
  );
}

/**
 * Access the translation function and current language.
 * Must be used inside a <LanguageProvider>.
 */
export function useTranslation(): I18nContextValue {
  const ctx = useContext(I18nContext);
  if (!ctx) {
    // Fallback — should never happen if provider is mounted,
    // but prevents crashes during incremental migration.
    return {
      lang: "zh",
      setLang: () => {},
      t: (key: string) => key,
    };
  }
  return ctx;
}
