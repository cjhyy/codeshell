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
  parseThemeManifest,
  type ThemeManifest,
  type ThemeSurfaceName,
  type ThemeSurface,
  type ThemeFrame,
} from "./manifest.js";
export { detectThemeImage, type ThemeImageInfo } from "./image.js";
