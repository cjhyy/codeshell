/**
 * Theme packs: swappable app color palettes layered over the light/dark base.
 *
 * A pack overrides a subset of the `--cs-*` semantic variables defined in
 * styles/tailwind.css. Light/dark stay orthogonal — a pack supplies which
 * values each mode uses, and the `.dark` class still decides which mode is
 * active (see theme.ts applyThemePack). Values are unitless HSL triples
 * ("H S% L%"), consumed via hsl(var(--cs-*)) exactly like the base sheet.
 *
 * First version ships color only. `pet` / `wallpaper` slots are reserved by the
 * design (docs/superpowers/specs/2026-07-27-theme-packs-design.md) and left off.
 */

/** Whitelist of overridable variables — must match names in tailwind.css. */
export const THEME_VAR_NAMES = [
  "--cs-background",
  "--cs-foreground",
  "--cs-card",
  "--cs-card-foreground",
  "--cs-popover",
  "--cs-popover-foreground",
  "--cs-primary",
  "--cs-primary-foreground",
  "--cs-secondary",
  "--cs-secondary-foreground",
  "--cs-muted",
  "--cs-muted-foreground",
  "--cs-accent",
  "--cs-accent-foreground",
  "--cs-destructive",
  "--cs-destructive-foreground",
  "--cs-border",
  "--cs-input",
  "--cs-ring",
  "--cs-status-running",
  "--cs-status-ok",
  "--cs-status-warn",
  "--cs-status-err",
  "--cs-status-idle",
] as const;

import type { TranslationKey } from "./i18n";

export type CssVarName = (typeof THEME_VAR_NAMES)[number];
export type ThemeVars = Partial<Record<CssVarName, string>>;

export interface ThemePack {
  /** Stable id persisted to localStorage. */
  id: string;
  /** i18n key for the display name. */
  name: TranslationKey;
  /** Representative color (unitless HSL) for the picker swatch — the pack's primary. */
  swatch: string;
  colors: {
    light: ThemeVars;
    dark: ThemeVars;
  };
}

export const DEFAULT_PACK_ID = "default";

/**
 * Built-in packs. `default` overrides nothing (falls through to the base sheet,
 * i.e. the current brand orange). Accent packs recolor the primary + focus ring
 * (and its foreground for contrast) in both modes; everything else inherits the
 * neutral base so density/contrast tuning is preserved.
 */
export const THEME_PACKS: ThemePack[] = [
  {
    id: "default",
    name: "settingsX.appearance.pack.default",
    swatch: "19 63% 45%",
    colors: { light: {}, dark: {} },
  },
  {
    id: "ocean",
    name: "settingsX.appearance.pack.ocean",
    swatch: "210 80% 45%",
    colors: {
      light: {
        "--cs-primary": "210 80% 45%",
        "--cs-primary-foreground": "0 0% 98%",
        "--cs-ring": "210 80% 45%",
      },
      dark: {
        "--cs-primary": "210 85% 60%",
        "--cs-primary-foreground": "0 0% 100%",
        "--cs-ring": "210 85% 60%",
      },
    },
  },
  {
    id: "forest",
    name: "settingsX.appearance.pack.forest",
    swatch: "150 55% 36%",
    colors: {
      light: {
        "--cs-primary": "150 55% 36%",
        "--cs-primary-foreground": "0 0% 98%",
        "--cs-ring": "150 55% 36%",
      },
      dark: {
        "--cs-primary": "150 55% 50%",
        "--cs-primary-foreground": "150 30% 8%",
        "--cs-ring": "150 55% 50%",
      },
    },
  },
  {
    id: "grape",
    name: "settingsX.appearance.pack.grape",
    swatch: "270 55% 52%",
    colors: {
      light: {
        "--cs-primary": "270 55% 52%",
        "--cs-primary-foreground": "0 0% 98%",
        "--cs-ring": "270 55% 52%",
      },
      dark: {
        "--cs-primary": "270 65% 68%",
        "--cs-primary-foreground": "0 0% 100%",
        "--cs-ring": "270 65% 68%",
      },
    },
  },
];

export function getThemePack(id: string): ThemePack {
  return THEME_PACKS.find((pack) => pack.id === id) ?? THEME_PACKS[0]!;
}
