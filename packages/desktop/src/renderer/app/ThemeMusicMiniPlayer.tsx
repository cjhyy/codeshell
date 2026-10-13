import React, { useSyncExternalStore } from "react";
import { Music2, Pause, Play, Square } from "lucide-react";
import { themeMusic } from "../theme-music";
import { useT } from "../i18n/I18nProvider";
import { Button } from "../components/ui/button";

/** Visible outside settings so background music can always be paused/stopped. */
export function ThemeMusicMiniPlayer() {
  const { t } = useT();
  const state = useSyncExternalStore(themeMusic.subscribe, themeMusic.getSnapshot);
  const track = state.tracks[state.selected];
  if (!state.active || !track) return null;
  return (
    <div
      className="flex shrink-0 items-center justify-end gap-2 border-b border-border bg-card/90 px-3 py-1"
      data-theme-music-dock
    >
      <Music2 size={13} className="shrink-0 text-primary" aria-hidden="true" />
      <span className="min-w-0 truncate text-xs text-muted-foreground">{track.title}</span>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="h-7 w-7"
        disabled={state.pending}
        aria-label={t(
          state.playing ? "settingsX.appearance.audio.pause" : "settingsX.appearance.audio.play",
        )}
        onClick={() => void themeMusic.toggle()}
      >
        {state.playing ? (
          <Pause size={13} aria-hidden="true" />
        ) : (
          <Play size={13} aria-hidden="true" />
        )}
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="h-7 w-7"
        data-theme-music-dock-stop
        aria-label={t("settingsX.appearance.audio.stop")}
        onClick={themeMusic.stop}
      >
        <Square size={12} aria-hidden="true" />
      </Button>
    </div>
  );
}
