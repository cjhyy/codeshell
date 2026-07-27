/**
 * Renderer-facing shapes for installable theme packs, shared between preload and
 * the renderer. Asset urls are cstheme:// links the main process resolves.
 */

export interface InstalledThemePack {
  id: string;
  name: string;
  swatch: string;
  colors: { light: Record<string, string>; dark: Record<string, string> };
  pet?: { idle?: string; running?: string; alert?: string; walk?: string[] };
  wallpaper?: { light?: string; dark?: string; opacity?: number };
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
        swatch?: string;
        reviewToken: string;
        warnings: string[];
      };
    };
