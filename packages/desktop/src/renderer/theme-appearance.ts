import type { CssVarName, ThemePack, ThemeSurfaceName, ThemeVars } from "./theme-packs";

const SURFACE_BACKGROUNDS: Record<ThemeSurfaceName, [CssVarName, number]> = {
  window: ["--cs-background", 1],
  sidebar: ["--cs-muted", 0.25],
  titlebar: ["--cs-background", 0.9],
  chat: ["--cs-background", 0],
  composer: ["--cs-card", 1],
  panel: ["--cs-background", 1],
};

/** Resolve once for both the actual host surface and its settings preview.
 * The host retains CSS tokens; miniature previews supply their own base palette.
 */
export function resolveThemeSurface(
  pack: ThemePack,
  name: ThemeSurfaceName,
  mode: "light" | "dark",
  basePalette: ThemeVars = {},
) {
  const appearance = pack.surfaces?.[name];
  // An explicit slot owns its whole surface, including intentionally no image.
  const source = appearance ?? (name === "window" ? pack.wallpaper : undefined);
  const image = source?.[mode] ?? source?.light;
  const color = appearance?.background?.[mode] ?? appearance?.background?.light;
  const [baseToken, baseOpacity] = SURFACE_BACKGROUNDS[name];
  return {
    image,
    opacity: image ? (source?.opacity ?? 1) : 0,
    fit: appearance?.fit ?? "cover",
    position: (appearance?.position ?? "center").replace("-", " "),
    background: color ?? basePalette[baseToken] ?? `var(${baseToken})`,
    backgroundOpacity: appearance?.backgroundOpacity ?? (color ? 1 : baseOpacity),
  };
}
