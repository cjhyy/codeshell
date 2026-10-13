import type { ThemeSoundEvent } from "../shared/theme-packs";
import type { ThemePack } from "./theme-packs";

export const THEME_AUDIO_KEY = "codeshell.theme-audio";
export interface ThemeAudioPreferences {
  enabled: boolean;
  soundVolume: number;
  musicVolume: number;
}

const DEFAULTS: ThemeAudioPreferences = { enabled: false, soundVolume: 0.35, musicVolume: 0.5 };
const volume = (value: unknown, fallback: number): number =>
  typeof value === "number" && Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : fallback;

export function loadThemeAudioPreferences(): ThemeAudioPreferences {
  try {
    const stored = JSON.parse(localStorage.getItem(THEME_AUDIO_KEY) ?? "null");
    return {
      enabled: stored?.enabled === true,
      soundVolume: volume(stored?.soundVolume, DEFAULTS.soundVolume),
      musicVolume: volume(stored?.musicVolume, DEFAULTS.musicVolume),
    };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveThemeAudioPreferences(preferences: ThemeAudioPreferences): void {
  try {
    localStorage.setItem(THEME_AUDIO_KEY, JSON.stringify(preferences));
  } catch {
    // A storage failure must not affect chat or explicit audio playback.
  }
  window.dispatchEvent(new Event("codeshell:theme-audio-changed"));
}

/** Small injectable HTMLAudio boundary; each channel owns at most one element. */
export type ThemeAudioElement = Pick<
  HTMLAudioElement,
  "src" | "volume" | "preload" | "loop" | "play" | "pause" | "load" | "onended" | "onerror"
>;

export class ThemeAudioPlayback {
  private audio: ThemeAudioElement | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly createAudio: () => ThemeAudioElement = () => new Audio()) {}

  private release(audio: ThemeAudioElement): void {
    audio.onended = null;
    audio.onerror = null;
    try {
      audio.pause();
      audio.src = "";
      audio.load();
    } catch {
      // Unsupported codecs / removed installed files are nonfatal.
    }
  }

  stop(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    const audio = this.audio;
    this.audio = null;
    if (audio) this.release(audio);
  }

  setVolume(value: number): void {
    if (this.audio) this.audio.volume = volume(value, 0.5);
  }

  setLoop(loop: boolean): void {
    if (this.audio) this.audio.loop = loop;
  }

  pause(): void {
    try {
      this.audio?.pause();
    } catch {
      this.stop();
    }
  }

  async resume(): Promise<boolean> {
    const audio = this.audio;
    if (!audio) return false;
    try {
      await audio.play();
      if (this.audio !== audio) {
        this.release(audio);
        return false;
      }
      return true;
    } catch {
      if (this.audio === audio) this.stop();
      return false;
    }
  }

  async play(
    src: string,
    level: number,
    onEnd: () => void = () => undefined,
    onError: () => void = () => undefined,
    maxDuration?: number,
  ): Promise<boolean> {
    this.stop();
    let attempted: ThemeAudioElement | null = null;
    try {
      const audio = this.createAudio();
      attempted = audio;
      this.audio = audio;
      audio.src = src;
      audio.preload = "none";
      audio.volume = volume(level, 0.5);
      audio.onended = () => {
        if (this.audio !== audio) return;
        this.stop();
        onEnd();
      };
      audio.onerror = () => {
        if (this.audio !== audio) return;
        this.stop();
        onError();
      };
      if (maxDuration !== undefined) {
        this.timer = setTimeout(() => {
          if (this.audio !== audio) return;
          this.stop();
          onEnd();
        }, maxDuration);
      }
      await audio.play();
      // A delayed play promise can settle after a theme change or unmount.
      if (this.audio !== audio) {
        this.release(audio);
        return false;
      }
      return true;
    } catch {
      if (attempted && this.audio === attempted) {
        this.stop();
        onError();
      }
      return false;
    }
  }
}

export class ThemeSoundPlayer {
  private signature = "";
  private pack: ThemePack | null = null;
  private lastPlay = -Infinity;
  private lastEvent: ThemeSoundEvent | null = null;
  private readonly recent = new Map<string, number>();

  constructor(
    private readonly playback = new ThemeAudioPlayback(),
    private readonly preferences = loadThemeAudioPreferences,
    // Only the focused main chat window plays automatic cues. Pet/popout
    // windows never mount this player, and duplicate main windows stay silent.
    private readonly focused = () => document.hasFocus(),
    private readonly now = Date.now,
  ) {}

  setPack(pack: ThemePack): void {
    const signature = JSON.stringify([pack.id, pack.sounds]);
    if (signature !== this.signature) {
      this.stop();
      this.recent.clear();
      this.lastPlay = -Infinity;
      this.lastEvent = null;
    }
    this.signature = signature;
    this.pack = pack;
  }

  stop(): void {
    this.playback.stop();
  }

  play(event: ThemeSoundEvent, preview = false, key?: string): void {
    try {
      const preferences = this.preferences();
      const src = this.pack?.sounds?.[event];
      if (!src || (!preview && (!preferences.enabled || !this.focused()))) return;
      const now = this.now();
      if (
        !preview &&
        ((event === this.lastEvent && now - this.lastPlay < 200) ||
          (key && now - (this.recent.get(key) ?? -Infinity) < 10_000))
      )
        return;
      this.lastPlay = now;
      this.lastEvent = event;
      if (key) {
        this.recent.set(key, now);
        if (this.recent.size > 256) this.recent.delete(this.recent.keys().next().value!);
      }
      void this.playback.play(src, preferences.soundVolume, undefined, undefined, 10_000);
    } catch {
      // Audio is decorative: no browser, storage or codec error can break chat.
    }
  }
}

let activePlayer: ThemeSoundPlayer | null = null;

/** App is the sole owner; pure settings/test mounts do not create a chat player. */
export function bindThemeSoundPlayer(player: ThemeSoundPlayer): () => void {
  activePlayer = player;
  return () => {
    player.stop();
    if (activePlayer === player) activePlayer = null;
  };
}

export function playThemeSound(event: ThemeSoundEvent, key?: string): void {
  activePlayer?.play(event, false, key);
}
