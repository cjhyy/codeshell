import manifest from "../../../../examples/themes/lovelive-maki/.cs-theme.json";
import schoolImage from "../../../../examples/themes/lovelive-maki/assets/maki-school.png";
import stageImage from "../../../../examples/themes/lovelive-maki/assets/maki-stage.png";
import type { ThemePack } from "./theme-packs";

// Keep the downloadable pack and bundled theme on the same artwork and palette.
// Static imports make Vite emit offline assets next to the renderer bundle.
const images: Record<string, string> = {
  "assets/maki-school.png": schoolImage,
  "assets/maki-stage.png": stageImage,
};

function bundledImage(path: string | undefined): string | undefined {
  if (!path) return undefined;
  const url = images[path];
  if (!url) throw new Error(`Missing bundled Maki theme image: ${path}`);
  return url;
}

// JSON imports widen fit/position literals. Retain the renderer's surface
// contract and the source pack's values without a Core runtime import.
const surfaces = manifest.surfaces as NonNullable<ThemePack["surfaces"]>;

export const MAKI_THEME_PACK: ThemePack = {
  // Separate from the downloadable lovelive-maki id so existing imports coexist.
  id: "maki",
  source: "builtin",
  name: "settingsX.appearance.pack.maki",
  swatch: manifest.colors.light["--cs-primary"],
  colors: manifest.colors,
  wallpaper: {
    ...manifest.wallpaper,
    light: bundledImage(manifest.wallpaper.light),
    dark: bundledImage(manifest.wallpaper.dark),
  },
  surfaces: Object.fromEntries(
    Object.entries(surfaces).map(([name, surface]) => [
      name,
      {
        ...surface,
        light: bundledImage(surface.light),
        dark: bundledImage(surface.dark),
      },
    ]),
  ),
  frame: manifest.frame,
};
