import mikuManifest from "../../../../examples/themes/hatsune-miku/.cs-theme.json";
import museManifest from "../../../../examples/themes/lovelive-muse/.cs-theme.json";
import mikuStage from "../../../../examples/themes/hatsune-miku/assets/stage.png";
import mikuSend from "../../../../examples/themes/hatsune-miku/assets/sound-send.wav";
import mikuComplete from "../../../../examples/themes/hatsune-miku/assets/sound-complete.wav";
import mikuApproval from "../../../../examples/themes/hatsune-miku/assets/sound-approval.wav";
import mikuError from "../../../../examples/themes/hatsune-miku/assets/sound-error.wav";
import mikuLoop from "../../../../examples/themes/hatsune-miku/assets/encore-loop.wav";
import museStage from "../../../../examples/themes/lovelive-muse/assets/stage.png";
import museSend from "../../../../examples/themes/lovelive-muse/assets/sound-send.wav";
import museComplete from "../../../../examples/themes/lovelive-muse/assets/sound-complete.wav";
import museApproval from "../../../../examples/themes/lovelive-muse/assets/sound-approval.wav";
import museError from "../../../../examples/themes/lovelive-muse/assets/sound-error.wav";
import museLoop from "../../../../examples/themes/lovelive-muse/assets/encore-loop.wav";
import onoderaManifest from "../../../../examples/themes/nisekoi-onodera/.cs-theme.json";
import onoderaStage from "../../../../examples/themes/nisekoi-onodera/assets/stage.png";
import onoderaSend from "../../../../examples/themes/nisekoi-onodera/assets/sound-send.wav";
import onoderaComplete from "../../../../examples/themes/nisekoi-onodera/assets/sound-complete.wav";
import onoderaApproval from "../../../../examples/themes/nisekoi-onodera/assets/sound-approval.wav";
import onoderaError from "../../../../examples/themes/nisekoi-onodera/assets/sound-error.wav";
import onoderaLoop from "../../../../examples/themes/nisekoi-onodera/assets/encore-loop.wav";
import misakaManifest from "../../../../examples/themes/misaka-mikoto/.cs-theme.json";
import misakaStage from "../../../../examples/themes/misaka-mikoto/assets/stage.png";
import misakaSend from "../../../../examples/themes/misaka-mikoto/assets/sound-send.wav";
import misakaComplete from "../../../../examples/themes/misaka-mikoto/assets/sound-complete.wav";
import misakaApproval from "../../../../examples/themes/misaka-mikoto/assets/sound-approval.wav";
import misakaError from "../../../../examples/themes/misaka-mikoto/assets/sound-error.wav";
import misakaLoop from "../../../../examples/themes/misaka-mikoto/assets/encore-loop.wav";
import type { ThemePack } from "./theme-packs";

/** Keep the bundled and downloadable themes on exactly the same palette and media. */
function bundledTheme(
  id: string,
  name: string,
  manifest: ThemePack,
  files: Record<string, string>,
): ThemePack {
  const asset = (path: string | undefined): string | undefined => {
    if (!path) return undefined;
    if (!files[path]) throw new Error(`Missing bundled ${id} theme asset: ${path}`);
    return files[path];
  };
  return {
    id,
    name,
    source: "builtin",
    swatch: manifest.colors.light["--cs-primary"]!,
    colors: manifest.colors,
    ...(manifest.wallpaper
      ? {
          wallpaper: {
            ...manifest.wallpaper,
            light: asset(manifest.wallpaper.light),
            dark: asset(manifest.wallpaper.dark),
          },
        }
      : {}),
    surfaces: Object.fromEntries(
      Object.entries(manifest.surfaces ?? {}).map(([surface, appearance]) => [
        surface,
        { ...appearance, light: asset(appearance.light), dark: asset(appearance.dark) },
      ]),
    ),
    frame: manifest.frame,
    sounds: Object.fromEntries(
      Object.entries(manifest.sounds ?? {}).map(([event, path]) => [event, asset(path)]),
    ),
    music: manifest.music?.map((track) => ({
      title: track.title,
      ...(track.artist ? { artist: track.artist } : {}),
      ...(track.file ? { file: asset(track.file)! } : { url: track.url! }),
    })),
  };
}

// Static imports let Vite package every asset for offline use. Separate ids let
// the independently installable versions coexist with their bundled equivalents.
export const MIKU_THEME_PACK = bundledTheme(
  "miku",
  "settingsX.appearance.pack.miku",
  mikuManifest as unknown as ThemePack,
  {
    "assets/stage.png": mikuStage,
    "assets/sound-send.wav": mikuSend,
    "assets/sound-complete.wav": mikuComplete,
    "assets/sound-approval.wav": mikuApproval,
    "assets/sound-error.wav": mikuError,
    "assets/encore-loop.wav": mikuLoop,
  },
);

export const MUSE_THEME_PACK = bundledTheme(
  "muse",
  "settingsX.appearance.pack.muse",
  museManifest as unknown as ThemePack,
  {
    "assets/stage.png": museStage,
    "assets/sound-send.wav": museSend,
    "assets/sound-complete.wav": museComplete,
    "assets/sound-approval.wav": museApproval,
    "assets/sound-error.wav": museError,
    "assets/encore-loop.wav": museLoop,
  },
);

export const ONODERA_THEME_PACK = bundledTheme(
  "onodera",
  "settingsX.appearance.pack.onodera",
  onoderaManifest as unknown as ThemePack,
  {
    "assets/stage.png": onoderaStage,
    "assets/sound-send.wav": onoderaSend,
    "assets/sound-complete.wav": onoderaComplete,
    "assets/sound-approval.wav": onoderaApproval,
    "assets/sound-error.wav": onoderaError,
    "assets/encore-loop.wav": onoderaLoop,
  },
);

export const MISAKA_THEME_PACK = bundledTheme(
  "misaka",
  "settingsX.appearance.pack.misaka",
  misakaManifest as unknown as ThemePack,
  {
    "assets/stage.png": misakaStage,
    "assets/sound-send.wav": misakaSend,
    "assets/sound-complete.wav": misakaComplete,
    "assets/sound-approval.wav": misakaApproval,
    "assets/sound-error.wav": misakaError,
    "assets/encore-loop.wav": misakaLoop,
  },
);
