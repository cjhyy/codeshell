import React, { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { ExternalLink, Music2, Pause, Play, SkipForward, Upload, Volume2 } from "lucide-react";
import type { ThemeSoundEvent } from "../../shared/theme-packs";
import type { ThemePack } from "../theme-packs";
import {
  loadThemeAudioPreferences,
  saveThemeAudioPreferences,
  ThemeSoundPlayer,
  THEME_AUDIO_KEY,
  type ThemeAudioPreferences,
} from "../theme-audio";
import { themeMusic } from "../theme-music";
import { useT } from "../i18n/I18nProvider";
import { Button } from "../components/ui/button";

const EVENTS: ThemeSoundEvent[] = ["send", "complete", "approval", "error"];

/** Audio stays explicit: selecting a theme or a track never starts music. */
export function ThemeAudioSection({ pack }: { pack: ThemePack }) {
  const { t } = useT();
  const [preferences, setPreferences] = useState(loadThemeAudioPreferences);
  const state = useSyncExternalStore(themeMusic.subscribe, themeMusic.getSnapshot);
  const { tracks, selected, playing, pending, repeat } = state;
  const [linkError, setLinkError] = useState<string | null>(null);
  const previews = useRef<ThemeSoundPlayer | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const track = tracks[selected];
  const soundEvents = EVENTS.filter((event) => pack.sounds?.[event]);
  const error = linkError ?? (state.error ? t(`settingsX.appearance.audio.${state.error}`) : null);

  useEffect(() => {
    previews.current = new ThemeSoundPlayer();
    const refreshPreferences = () => setPreferences(loadThemeAudioPreferences());
    const stopPreviews = () => previews.current?.stop();
    const onStorage = (event: StorageEvent) => {
      if (event.key === THEME_AUDIO_KEY || event.key === null) refreshPreferences();
      if (event.key === "codeshell.theme-pack" || event.key === null) stopPreviews();
    };
    window.addEventListener("storage", onStorage);
    window.addEventListener("codeshell:theme-pack-changed", stopPreviews);
    window.addEventListener("codeshell:theme-audio-changed", refreshPreferences);
    const offChanged = window.codeshell?.onThemesChanged?.(stopPreviews);
    return () => {
      previews.current?.stop();
      offChanged?.();
      window.removeEventListener("storage", onStorage);
      window.removeEventListener("codeshell:theme-pack-changed", stopPreviews);
      window.removeEventListener("codeshell:theme-audio-changed", refreshPreferences);
    };
  }, []);

  const audioSignature = JSON.stringify([pack.id, pack.sounds, pack.music]);
  useEffect(() => {
    previews.current?.setPack(pack);
    themeMusic.setPack(pack);
    setLinkError(null);
  }, [audioSignature]);

  useEffect(() => {
    themeMusic.setVolume(preferences.musicVolume);
    previews.current?.stop();
  }, [preferences]);

  const updatePreferences = (patch: Partial<ThemeAudioPreferences>): void => {
    const next = { ...preferences, ...patch };
    setPreferences(next);
    saveThemeAudioPreferences(next);
  };

  const chooseTrack = (index: number): void => {
    themeMusic.select(index);
    setLinkError(null);
  };

  const openTrack = async (): Promise<void> => {
    if (!track?.url) return;
    try {
      await window.codeshell.openExternal(track.url);
    } catch {
      setLinkError(t("settingsX.appearance.audio.openFailed"));
    }
  };

  const importFiles = (files: FileList | null): void => {
    if (files) themeMusic.importFiles(files);
    if (fileInput.current) fileInput.current.value = "";
  };

  return (
    <div className="mt-3 space-y-4 rounded-xl border border-border bg-card/70 p-4" data-theme-audio>
      <div className="space-y-2">
        <h4 className="m-0 flex items-center gap-2 text-sm font-medium">
          <Volume2 size={15} aria-hidden="true" />
          {t("settingsX.appearance.audio.sounds")}
        </h4>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            data-theme-sounds-enabled
            checked={preferences.enabled}
            onChange={(event) => updatePreferences({ enabled: event.target.checked })}
          />
          {t("settingsX.appearance.audio.enable")}
        </label>
        <p className="m-0 text-xs text-muted-foreground">
          {t("settingsX.appearance.audio.soundHint")}
        </p>
        <label className="flex items-center gap-3 text-xs">
          {t("settingsX.appearance.audio.soundVolume")}
          <input
            type="range"
            min={0}
            max={100}
            step={1}
            value={Math.round(preferences.soundVolume * 100)}
            aria-label={t("settingsX.appearance.audio.soundVolume")}
            onChange={(event) =>
              updatePreferences({ soundVolume: Number(event.target.value) / 100 })
            }
          />
          <span className="tabular-nums">{Math.round(preferences.soundVolume * 100)}%</span>
        </label>
        {soundEvents.length ? (
          <div className="flex flex-wrap gap-2">
            {soundEvents.map((event) => (
              <Button
                type="button"
                key={event}
                variant="outline"
                size="sm"
                data-theme-sound-preview={event}
                onClick={() => previews.current?.play(event, true)}
              >
                <Play size={12} aria-hidden="true" />
                {t(`settingsX.appearance.audio.${event}`)}
              </Button>
            ))}
          </div>
        ) : (
          <p className="m-0 text-xs text-muted-foreground">
            {t("settingsX.appearance.audio.noSounds")}
          </p>
        )}
      </div>

      <div className="space-y-2 border-t border-border pt-3">
        <div className="flex items-center justify-between gap-2">
          <h4 className="m-0 flex items-center gap-2 text-sm font-medium">
            <Music2 size={15} aria-hidden="true" />
            {t("settingsX.appearance.audio.music")}
          </h4>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => fileInput.current?.click()}
          >
            <Upload size={13} aria-hidden="true" />
            {t("settingsX.appearance.audio.importLocal")}
          </Button>
          <input
            ref={fileInput}
            type="file"
            className="hidden"
            accept=".mp3,.wav,audio/mpeg,audio/wav"
            multiple
            data-theme-music-import
            onChange={(event) => importFiles(event.target.files)}
          />
        </div>
        <p className="m-0 text-xs text-muted-foreground">
          {t("settingsX.appearance.audio.musicHint")}
        </p>
        {tracks.length ? (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <select
                className="h-9 min-w-0 flex-1 rounded-md border border-input bg-background px-2 text-sm"
                aria-label={t("settingsX.appearance.audio.chooseTrack")}
                value={selected}
                data-theme-music-select
                onChange={(event) => chooseTrack(Number(event.target.value))}
              >
                {tracks.map((item, index) => (
                  <option key={index} value={index}>
                    {item.title}
                    {item.artist ? ` · ${item.artist}` : ""}
                  </option>
                ))}
              </select>
              {track?.file ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={pending}
                  data-theme-music-play
                  onClick={() => void themeMusic.toggle()}
                >
                  {playing ? (
                    <Pause size={13} aria-hidden="true" />
                  ) : (
                    <Play size={13} aria-hidden="true" />
                  )}
                  {t(
                    playing
                      ? "settingsX.appearance.audio.pause"
                      : "settingsX.appearance.audio.play",
                  )}
                </Button>
              ) : (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  data-theme-music-open
                  onClick={() => void openTrack()}
                >
                  <ExternalLink size={13} aria-hidden="true" />
                  {t("settingsX.appearance.audio.openOfficial")}
                </Button>
              )}
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={t("settingsX.appearance.audio.next")}
                disabled={tracks.length < 2}
                onClick={themeMusic.next}
              >
                <SkipForward size={14} aria-hidden="true" />
              </Button>
            </div>
            <label className="flex items-center gap-3 text-xs">
              {t("settingsX.appearance.audio.musicVolume")}
              <input
                type="range"
                min={0}
                max={100}
                step={1}
                value={Math.round(preferences.musicVolume * 100)}
                aria-label={t("settingsX.appearance.audio.musicVolume")}
                onChange={(event) =>
                  updatePreferences({ musicVolume: Number(event.target.value) / 100 })
                }
              />
              <span className="tabular-nums">{Math.round(preferences.musicVolume * 100)}%</span>
            </label>
          </>
        ) : (
          <p className="m-0 text-xs text-muted-foreground">
            {t("settingsX.appearance.audio.noMusic")}
          </p>
        )}
        <label className="flex items-center gap-2 text-xs">
          <input
            type="checkbox"
            checked={repeat}
            data-theme-music-repeat
            onChange={(event) => themeMusic.setRepeat(event.target.checked)}
          />
          {t("settingsX.appearance.audio.repeat")}
        </label>
        <p className="m-0 text-xs text-muted-foreground">
          {t("settingsX.appearance.audio.localHint")}
        </p>
        {error && (
          <p className="m-0 text-xs text-destructive" role="alert">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}
