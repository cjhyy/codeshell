import { useEffect } from "react";
import { resolveThemePack, subscribeInstalledThemes } from "../installedThemes";
import { loadThemePackId } from "../theme";
import { bindThemeSoundPlayer, ThemeSoundPlayer, THEME_AUDIO_KEY } from "../theme-audio";
import { loadThemeAudioPreferences } from "../theme-audio";
import { themeMusic } from "../theme-music";

/** Mount only in the main chat App, never the widget or other auxiliary windows. */
export function useThemeAudio(): void {
  useEffect(() => {
    const player = new ThemeSoundPlayer();
    const unbind = bindThemeSoundPlayer(player);
    const sync = () => {
      const pack = resolveThemePack(loadThemePackId());
      player.setPack(pack);
      themeMusic.setPack(pack);
    };
    const stop = () => player.stop();
    const preferences = () => {
      stop();
      themeMusic.setVolume(loadThemeAudioPreferences().musicVolume);
    };
    const storage = (event: StorageEvent) => {
      if (event.key === "codeshell.theme-pack" || event.key === null) sync();
      if (event.key === THEME_AUDIO_KEY || event.key === null) preferences();
    };
    sync();
    window.addEventListener("storage", storage);
    window.addEventListener("codeshell:theme-pack-changed", sync);
    window.addEventListener("codeshell:theme-audio-changed", preferences);
    window.addEventListener("blur", stop);
    const offInstalled = subscribeInstalledThemes(sync);
    // Stop immediately, before the asynchronous installed-cache refresh.
    const offChanged = window.codeshell.onThemesChanged?.(() => {
      stop();
      themeMusic.dispose();
    });
    return () => {
      unbind();
      themeMusic.dispose();
      offInstalled();
      offChanged?.();
      window.removeEventListener("storage", storage);
      window.removeEventListener("codeshell:theme-pack-changed", sync);
      window.removeEventListener("codeshell:theme-audio-changed", preferences);
      window.removeEventListener("blur", stop);
    };
  }, []);
}
