import type { ThemeMusicTrack } from "../shared/theme-packs";
import type { ThemePack } from "./theme-packs";
import { loadThemeAudioPreferences, ThemeAudioPlayback } from "./theme-audio";

export interface ThemeMusicState {
  packId: string;
  tracks: ThemeMusicTrack[];
  selected: number;
  active: boolean;
  playing: boolean;
  pending: boolean;
  repeat: boolean;
  error: "playFailed" | "importLimit" | null;
}

const initialState = (): ThemeMusicState => ({
  packId: "",
  tracks: [],
  selected: 0,
  active: false,
  playing: false,
  pending: false,
  repeat: true,
  error: null,
});

/** Main App owns lifetime; settings and the compact player only subscribe. */
export class ThemeMusicStore {
  private state = initialState();
  private readonly listeners = new Set<() => void>();
  private signature = "";
  private generation = 0;
  private started: number | null = null;
  private importedUrls: string[] = [];

  constructor(private readonly playback = new ThemeAudioPlayback()) {}

  getSnapshot = (): ThemeMusicState => this.state;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private update(patch: Partial<ThemeMusicState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }

  private revokeImports(): void {
    for (const url of this.importedUrls) URL.revokeObjectURL(url);
    this.importedUrls = [];
  }

  setPack(pack: ThemePack): void {
    const signature = JSON.stringify([pack.id, pack.music]);
    if (this.signature === signature) return;
    this.stop();
    this.revokeImports();
    this.signature = signature;
    this.update({ packId: pack.id, tracks: [...(pack.music ?? [])], selected: 0, error: null });
  }

  stop = (): void => {
    this.generation += 1;
    this.playback.stop();
    this.started = null;
    this.update({ active: false, playing: false, pending: false });
  };

  dispose(): void {
    this.stop();
    this.revokeImports();
    this.signature = "";
    this.state = initialState();
    for (const listener of this.listeners) listener();
  }

  setVolume(level: number): void {
    this.playback.setVolume(level);
  }

  setRepeat(repeat: boolean): void {
    this.playback.setLoop(repeat);
    this.update({ repeat });
  }

  select(index: number): void {
    if (!Number.isInteger(index) || index < 0 || index >= this.state.tracks.length) return;
    this.stop();
    this.update({ selected: index, error: null });
  }

  next = (): void => {
    if (this.state.tracks.length) this.select((this.state.selected + 1) % this.state.tracks.length);
  };

  toggle = async (): Promise<void> => {
    const { tracks, selected, playing, pending, repeat } = this.state;
    const track = tracks[selected];
    if (!track?.file || pending) return;
    if (playing) {
      this.playback.pause();
      this.update({ playing: false });
      return;
    }
    const token = ++this.generation;
    this.update({ pending: true, active: true, error: null });
    const finish = () => {
      this.started = null;
      this.update({ playing: false, pending: false, active: false });
    };
    const fail = () => {
      finish();
      this.update({ error: "playFailed" });
    };
    const promise =
      this.started === selected
        ? this.playback.resume()
        : this.playback.play(track.file, loadThemeAudioPreferences().musicVolume, finish, fail);
    this.playback.setLoop(repeat);
    const success = await promise;
    if (token !== this.generation) return;
    this.started = success ? selected : null;
    this.update({
      pending: false,
      playing: success,
      active: success,
      ...(success ? {} : { error: "playFailed" }),
    });
  };

  importFiles(files: FileList | File[]): void {
    const accepted: ThemeMusicTrack[] = [];
    let rejected = false;
    for (const file of Array.from(files)) {
      if (
        !/\.(mp3|wav)$/i.test(file.name) ||
        file.size > 50 * 1024 * 1024 ||
        this.importedUrls.length >= 12
      ) {
        rejected = true;
        continue;
      }
      const url = URL.createObjectURL(file);
      this.importedUrls.push(url);
      accepted.push({ title: file.name.replace(/\.(mp3|wav)$/i, ""), file: url });
    }
    this.update({
      tracks: [...this.state.tracks, ...accepted],
      error: rejected ? "importLimit" : null,
    });
  }
}

export const themeMusic = new ThemeMusicStore();
