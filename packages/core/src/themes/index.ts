export {
  previewLocalTheme,
  installReviewedLocalTheme,
  listInstalledThemes,
  uninstallTheme,
  type ThemePreview,
  type InstalledTheme,
} from "./installer.js";
export {
  THEME_ASSET_DIR,
  ThemeInstallError,
  ThemeReviewChangedError,
  assertSafeThemeName,
  themeInstallDir,
  themesRoot,
} from "./paths.js";
export {
  THEME_VAR_NAMES,
  THEME_ID,
  THEME_SURFACE_NAMES,
  THEME_SOUND_EVENTS,
  parseThemeManifest,
  type ThemeManifest,
  type ThemeSurfaceName,
  type ThemeSurface,
  type ThemeFrame,
  type ThemeSoundEvent,
  type ThemeMusicTrack,
} from "./manifest.js";
export { detectThemeImage, type ThemeImageInfo } from "./image.js";
export {
  detectThemeWav,
  MAX_THEME_SOUND_BYTES,
  MAX_THEME_MUSIC_BYTES,
  type ThemeWavInfo,
} from "./audio.js";
