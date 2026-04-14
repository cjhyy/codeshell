/**
 * Theme adapter for the lightweight UI layer.
 *
 * Delegates to the canonical theme system (utils/theme.ts) and the
 * design-system ThemeProvider so that both the ui/ REPL and the
 * restored components share a single source of truth for colors.
 *
 * This file re-exports the types and provides a slim ThemeProvider
 * that doesn't pull in heavy dependencies (globalConfig, bun:bundle
 * feature flags, useStdin) that the full ThemeProvider needs.
 */
import { createContext, useContext, useState, useMemo, createElement, type ReactNode } from "react";
import {
  getTheme,
  type Theme,
  type ThemeName,
  type ThemeSetting,
} from "../utils/theme.js";
import { resolveThemeSetting } from "../utils/systemTheme.js";

// ─── Re-exports from canonical theme ──────────────────────────────
// Consumers import these from here to avoid reaching into utils/ directly.

export { getTheme, type Theme, type ThemeName, type ThemeSetting } from "../utils/theme.js";
export { resolveThemeSetting } from "../utils/systemTheme.js";

/**
 * Resolve a color that may be a theme key or raw color value.
 * Matches the logic in components/design-system/ThemedText.tsx.
 */
export function resolveColor(
  color: keyof Theme | string | undefined,
  theme: Theme,
): string | undefined {
  if (!color) return undefined;
  // Raw color passthrough
  if (
    color.startsWith("rgb(") ||
    color.startsWith("#") ||
    color.startsWith("ansi256(") ||
    color.startsWith("ansi:")
  ) {
    return color;
  }
  // Theme key
  return (theme as unknown as Record<string, string>)[color] || undefined;
}

// ─── Lightweight React Context ─────────────────────────────────────
// Mirrors the interface of design-system/ThemeProvider but without the
// heavy deps (globalConfig persistence, OSC watcher, bun:bundle flags).

interface ThemeContextValue {
  themeName: ThemeName;
  theme: Theme;
  themeSetting: ThemeSetting;
  setThemeSetting: (setting: ThemeSetting) => void;
}

const ThemeContext = createContext<ThemeContextValue>({
  themeName: "dark",
  theme: getTheme("dark"),
  themeSetting: "auto",
  setThemeSetting: () => {},
});

/**
 * Returns [resolvedThemeName, themeObject].
 * API-compatible with design-system/ThemeProvider's useTheme().
 */
export function useTheme(): [ThemeName, Theme] {
  const ctx = useContext(ThemeContext);
  return [ctx.themeName, ctx.theme];
}

export function useThemeSetting(): [ThemeSetting, (s: ThemeSetting) => void] {
  const ctx = useContext(ThemeContext);
  return [ctx.themeSetting, ctx.setThemeSetting];
}

export function ThemeProvider({
  children,
  initialSetting = "auto",
}: {
  children: ReactNode;
  initialSetting?: ThemeSetting;
}) {
  const [themeSetting, setThemeSetting] = useState<ThemeSetting>(initialSetting);
  const themeName = resolveThemeSetting(themeSetting);
  const theme = getTheme(themeName);

  const value = useMemo(
    () => ({ themeName, theme, themeSetting, setThemeSetting }),
    [themeName, theme, themeSetting],
  );

  return createElement(ThemeContext.Provider, { value }, children);
}
