import { z } from "zod";

/**
 * Theme-pack manifest (`.cs-theme.json`) schema and validation.
 *
 * A pack may override app colors (a whitelisted subset of `--cs-*`, unitless
 * HSL), supply per-state pet sprites, light/dark wallpapers, and per-surface
 * backgrounds, a window frame, feedback sounds, and a listening playlist. All
 * are optional. Local media fields declare author-relative paths that the
 * installer validates and renames to a canonical layout; this schema checks
 * shape, while the installer checks the media bytes.
 */

/** Overridable CSS variables — must stay in sync with the renderer whitelist. */
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

const VAR_SET = new Set<string>(THEME_VAR_NAMES);

/** Unitless HSL triple, e.g. "19 63% 45%". */
const HSL = /^\d+(?:\.\d+)?\s+\d+(?:\.\d+)?%\s+\d+(?:\.\d+)?%$/;

const ThemeVarsSchema = z
  .record(z.string())
  .refine((vars) => Object.keys(vars).every((name) => VAR_SET.has(name)), {
    message: "unknown --cs-* variable (not in the theme whitelist)",
  })
  .refine((vars) => Object.values(vars).every((value) => HSL.test(value)), {
    message: "color values must be unitless HSL triples like '19 63% 45%'",
  });

/** A single safe path segment — no traversal, separators, or NUL. */
const RELATIVE_ASSET = z
  .string()
  .min(1)
  .refine(
    (p) =>
      !p.includes("\0") &&
      !p.includes("\\") &&
      !p.startsWith("/") &&
      !p.split("/").some((seg) => seg === "" || seg === "." || seg === ".."),
    { message: "asset path must be a relative path with no traversal" },
  );

export const THEME_ID = /^[a-z0-9][a-z0-9-]{1,63}$/;

/** Host UI surfaces with independently configurable backgrounds. */
export const THEME_SURFACE_NAMES = [
  "window",
  "sidebar",
  "titlebar",
  "chat",
  "composer",
  "panel",
] as const;

const ThemeModeColorsSchema = z
  .object({
    light: z.string().regex(HSL).optional(),
    dark: z.string().regex(HSL).optional(),
  })
  .strict();

const ThemeSurfaceSchema = z
  .object({
    light: RELATIVE_ASSET.optional(),
    dark: RELATIVE_ASSET.optional(),
    opacity: z.number().min(0).max(1).optional(),
    fit: z.enum(["cover", "contain"]).optional(),
    position: z
      .enum(["center", "top", "bottom", "left", "right", "top-right", "bottom-right"])
      .optional(),
    background: ThemeModeColorsSchema.optional(),
    backgroundOpacity: z.number().min(0).max(1).optional(),
  })
  .strict();

const ThemeFrameSchema = ThemeModeColorsSchema.extend({
  width: z.number().min(0).max(8).optional(),
  radius: z.number().min(0).max(24).optional(),
});

export type ThemeSurfaceName = (typeof THEME_SURFACE_NAMES)[number];
export type ThemeSurface = z.infer<typeof ThemeSurfaceSchema>;
export type ThemeFrame = z.infer<typeof ThemeFrameSchema>;

/** Host feedback events whose default sounds can be replaced by a pack. */
export const THEME_SOUND_EVENTS = ["send", "complete", "approval", "error"] as const;
export type ThemeSoundEvent = (typeof THEME_SOUND_EVENTS)[number];

const ThemeSoundsSchema = z
  .object({
    send: RELATIVE_ASSET.optional(),
    complete: RELATIVE_ASSET.optional(),
    approval: RELATIVE_ASSET.optional(),
    error: RELATIVE_ASSET.optional(),
  })
  .strict();

const ThemeMusicTrackSchema = z
  .object({
    title: z.string().trim().min(1).max(120),
    artist: z.string().trim().min(1).max(120).optional(),
    file: RELATIVE_ASSET.optional(),
    url: z
      .string()
      .max(4096)
      .url()
      .refine((value) => {
        try {
          const url = new URL(value);
          return url.protocol === "https:" && !url.username && !url.password;
        } catch {
          return false;
        }
      }, "music links must use HTTPS without credentials")
      .optional(),
  })
  .strict()
  .refine((track) => Boolean(track.file) !== Boolean(track.url), {
    message: "music tracks must declare exactly one file or HTTPS URL",
  });

export type ThemeMusicTrack = z.infer<typeof ThemeMusicTrackSchema>;

export const ThemeManifestSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().regex(THEME_ID, "id must match ^[a-z0-9][a-z0-9-]{1,63}$"),
  name: z.string().min(1).max(80),
  version: z.string().min(1).max(32),
  colors: z
    .object({ light: ThemeVarsSchema.optional(), dark: ThemeVarsSchema.optional() })
    .optional(),
  pet: z
    .object({
      idle: RELATIVE_ASSET.optional(),
      running: RELATIVE_ASSET.optional(),
      alert: RELATIVE_ASSET.optional(),
      /** Ordered frames cycled while the widget is dragged (a "run" loop). */
      walk: z.array(RELATIVE_ASSET).max(16).optional(),
    })
    .optional(),
  wallpaper: z
    .object({
      light: RELATIVE_ASSET.optional(),
      dark: RELATIVE_ASSET.optional(),
      opacity: z.number().min(0).max(1).optional(),
    })
    .optional(),
  surfaces: z
    .object({
      window: ThemeSurfaceSchema.optional(),
      sidebar: ThemeSurfaceSchema.optional(),
      titlebar: ThemeSurfaceSchema.optional(),
      chat: ThemeSurfaceSchema.optional(),
      composer: ThemeSurfaceSchema.optional(),
      panel: ThemeSurfaceSchema.optional(),
    })
    .strict()
    .optional(),
  frame: ThemeFrameSchema.optional(),
  sounds: ThemeSoundsSchema.optional(),
  music: z.array(ThemeMusicTrackSchema).max(12).optional(),
});

export type ThemeManifest = z.infer<typeof ThemeManifestSchema>;

/** Parse + validate a raw `.cs-theme.json` object. Throws ZodError on invalid input. */
export function parseThemeManifest(raw: unknown): ThemeManifest {
  return ThemeManifestSchema.parse(raw);
}
