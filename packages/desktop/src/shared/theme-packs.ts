/**
 * Renderer-facing shapes for installable theme packs, shared between preload and
 * the renderer. Asset urls are cstheme:// links the main process resolves.
 */

import type { ThemeFrame, ThemeSurface, ThemeSurfaceName } from "@cjhyy/code-shell-core";

export type ThemeImportKind = "zip" | "directory";

export type ThemeSoundEvent = "send" | "complete" | "approval" | "error";
export type ThemeSounds = Partial<Record<ThemeSoundEvent, string>>;
/** Local files are resolved asset URLs; web tracks open only on an explicit click. */
export type ThemeMusicTrack = { title: string; artist?: string } & (
  | { file: string; url?: never }
  | { url: string; file?: never }
);

export interface InstalledThemePack {
  id: string;
  name: string;
  swatch: string;
  colors: { light: Record<string, string>; dark: Record<string, string> };
  pet?: { idle?: string; running?: string; alert?: string; walk?: string[] };
  wallpaper?: { light?: string; dark?: string; opacity?: number };
  surfaces?: Partial<Record<ThemeSurfaceName, ThemeSurface>>;
  frame?: ThemeFrame;
  sounds?: ThemeSounds;
  music?: ThemeMusicTrack[];
  source: "installed";
}

/** Result of the pick-and-preview step before a user confirms an install. */
export type ThemePickPreview =
  | { cancelled: true }
  | {
      cancelled: false;
      path: string;
      preview: {
        id: string;
        name: string;
        version: string;
        hasColors: boolean;
        petStates: Array<"idle" | "running" | "alert">;
        wallpaperModes: Array<"light" | "dark">;
        surfaceNames?: ThemeSurfaceName[];
        hasFrame?: boolean;
        soundEvents?: ThemeSoundEvent[];
        musicCount?: number;
        swatch?: string;
        reviewToken: string;
        warnings: string[];
      };
    };
