import { z } from "zod";

/**
 * Theme-pack manifest (`.cs-theme.json`) schema and validation.
 *
 * A pack may override app colors (a whitelisted subset of `--cs-*`, unitless
 * HSL), supply per-state pet sprites, and a light/dark wallpaper. All three are
 * optional — a pack can recolor only, reskin the pet only, etc. Image fields
 * declare author-relative paths that the installer validates and renames to a
 * canonical layout; the manifest here only checks shape, not the image bytes.
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
    })
    .optional(),
  wallpaper: z
    .object({
      light: RELATIVE_ASSET.optional(),
      dark: RELATIVE_ASSET.optional(),
      opacity: z.number().min(0).max(1).optional(),
    })
    .optional(),
});

export type ThemeManifest = z.infer<typeof ThemeManifestSchema>;

/** Parse + validate a raw `.cs-theme.json` object. Throws ZodError on invalid input. */
export function parseThemeManifest(raw: unknown): ThemeManifest {
  return ThemeManifestSchema.parse(raw);
}
