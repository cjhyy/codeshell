import type { InstalledTheme } from "@cjhyy/code-shell-core";
import type { InstalledThemePack } from "../shared/theme-packs.js";
import { themeAssetUrl } from "./theme-asset-url.js";

/** Convert the two image modes while retaining every appearance control. */
function withAssetUrls<T extends { light?: string; dark?: string }>(
  appearance: T,
  asset: (relativePath: string) => string,
): T {
  return {
    ...appearance,
    ...(appearance.light ? { light: asset(appearance.light) } : {}),
    ...(appearance.dark ? { dark: asset(appearance.dark) } : {}),
  };
}

/** Renderer pack with canonical local asset paths replaced by cstheme:// URLs. */
export function installedThemeToPack(theme: InstalledTheme): InstalledThemePack {
  const asset = (rel: string): string => themeAssetUrl(theme.id, rel);
  const pet: NonNullable<InstalledThemePack["pet"]> = {};
  if (theme.pet.idle) pet.idle = asset(theme.pet.idle);
  if (theme.pet.running) pet.running = asset(theme.pet.running);
  if (theme.pet.alert) pet.alert = asset(theme.pet.alert);
  if (theme.pet.walk?.length) pet.walk = theme.pet.walk.map(asset);
  const surfaces = theme.surfaces
    ? Object.fromEntries(
        Object.entries(theme.surfaces).flatMap(([name, surface]) =>
          surface ? [[name, withAssetUrls(surface, asset)]] : [],
        ),
      )
    : undefined;
  return {
    id: theme.id,
    name: theme.name,
    swatch: theme.colors.light["--cs-primary"] ?? theme.colors.dark["--cs-primary"] ?? "0 0% 50%",
    colors: theme.colors,
    ...(Object.keys(pet).length ? { pet } : {}),
    ...(theme.wallpaper ? { wallpaper: withAssetUrls(theme.wallpaper, asset) } : {}),
    ...(surfaces ? { surfaces } : {}),
    ...(theme.frame ? { frame: theme.frame } : {}),
    source: "installed",
  };
}
