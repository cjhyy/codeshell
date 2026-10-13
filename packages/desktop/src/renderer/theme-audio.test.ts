import { afterEach, describe, expect, test } from "bun:test";
import {
  loadThemeAudioPreferences,
  ThemeAudioPlayback,
  ThemeSoundPlayer,
  THEME_AUDIO_KEY,
  type ThemeAudioElement,
} from "./theme-audio";
import type { ThemePack } from "./theme-packs";

class FakeAudio implements ThemeAudioElement {
  src = "";
  volume = 1;
  preload = "";
  loop = false;
  onended: HTMLAudioElement["onended"] = null;
  onerror: HTMLAudioElement["onerror"] = null;
  pauses = 0;
  loads = 0;
  plays = 0;
  playResult = Promise.resolve();
  play() {
    this.plays += 1;
    return this.playResult;
  }
  pause() {
    this.pauses += 1;
  }
  load() {
    this.loads += 1;
  }
}

const pack: ThemePack = {
  id: "audio-theme",
  name: "Audio theme",
  swatch: "180 60% 50%",
  colors: { light: {}, dark: {} },
  sounds: { send: "cstheme://audio-theme/send.wav", complete: "cstheme://audio-theme/done.wav" },
};

const storageDescriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
afterEach(() => {
  if (storageDescriptor) Object.defineProperty(globalThis, "localStorage", storageDescriptor);
  else Reflect.deleteProperty(globalThis, "localStorage");
});

describe("theme audio lifetime", () => {
  test("replaces overlapping audio and rejects stale play completion after disposal", async () => {
    const elements: FakeAudio[] = [];
    let settle!: () => void;
    const playback = new ThemeAudioPlayback(() => {
      const audio = new FakeAudio();
      if (!elements.length) audio.playResult = new Promise((resolve) => (settle = resolve));
      elements.push(audio);
      return audio;
    });
    const pending = playback.play("first.wav", 0.4);
    expect(await playback.play("second.wav", 0.7)).toBe(true);
    expect(elements[0]!.src).toBe("");
    expect(elements[0]!.pauses).toBe(1);
    expect(elements[1]!.volume).toBe(0.7);
    settle();
    expect(await pending).toBe(false);
    expect(elements[0]!.pauses).toBe(2);
    playback.stop();
    expect(elements[1]!.src).toBe("");
    expect(elements[1]!.onended).toBe(null);
  });

  test("music can pause/resume the same element and update volume", async () => {
    const audio = new FakeAudio();
    const playback = new ThemeAudioPlayback(() => audio);
    expect(await playback.play("song.wav", 0.5)).toBe(true);
    playback.pause();
    expect(audio.src).toBe("song.wav");
    expect(await playback.resume()).toBe(true);
    expect(audio.plays).toBe(2);
    playback.setVolume(2);
    expect(audio.volume).toBe(1);
    playback.stop();
    expect(await playback.resume()).toBe(false);
  });

  test("a rejected or later failed audio stops safely", async () => {
    const audio = new FakeAudio();
    const playback = new ThemeAudioPlayback(() => audio);
    let errors = 0;
    audio.playResult = Promise.reject(new Error("Unsupported codec"));
    expect(await playback.play("bad.wav", 0.5, undefined, () => errors++)).toBe(false);
    expect(errors).toBe(1);
    expect(audio.src).toBe("");
    audio.playResult = Promise.resolve();
    await playback.play("removed.wav", 0.5, undefined, () => errors++);
    audio.onerror?.call(audio as unknown as HTMLAudioElement, new Event("error"));
    expect(errors).toBe(2);
    expect(audio.src).toBe("");
  });

  test("short UI cues have a maximum playback duration", async () => {
    const audio = new FakeAudio();
    const playback = new ThemeAudioPlayback(() => audio);
    let ended = false;
    await playback.play(
      "long.wav",
      0.5,
      () => {
        ended = true;
      },
      undefined,
      5,
    );
    await new Promise((resolve) => setTimeout(resolve, 15));
    expect(ended).toBe(true);
    expect(audio.src).toBe("");
  });
});

describe("theme event sound policy", () => {
  test("defaults off and tolerates invalid or unavailable preferences", () => {
    let value: string | null = null;
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: { getItem: (key: string) => (key === THEME_AUDIO_KEY ? value : null) },
    });
    expect(loadThemeAudioPreferences().enabled).toBe(false);
    value = "bad JSON";
    expect(loadThemeAudioPreferences().enabled).toBe(false);
    value = JSON.stringify({ enabled: "yes", soundVolume: -10, musicVolume: 9 });
    expect(loadThemeAudioPreferences()).toEqual({ enabled: false, soundVolume: 0, musicVolume: 1 });
  });

  test("plays previews while disabled; automatic cues require focus and opt-in", () => {
    const elements: FakeAudio[] = [];
    let enabled = false;
    let focused = false;
    let now = 1_000;
    const player = new ThemeSoundPlayer(
      new ThemeAudioPlayback(() => {
        const audio = new FakeAudio();
        elements.push(audio);
        return audio;
      }),
      () => ({ enabled, soundVolume: 0.2, musicVolume: 0.8 }),
      () => focused,
      () => now,
    );
    player.setPack(pack);
    player.play("send");
    expect(elements).toHaveLength(0);
    player.play("send", true);
    expect(elements).toHaveLength(1);
    enabled = true;
    now += 500;
    player.play("send");
    expect(elements).toHaveLength(1);
    focused = true;
    player.play("send", false, "input-1");
    expect(elements).toHaveLength(2);
    expect(elements[1]!.volume).toBe(0.2);
    expect(elements[0]!.src).toBe("");
    now += 500;
    player.play("send", false, "input-1");
    expect(elements).toHaveLength(2);
    player.play("complete", false, "turn-1");
    expect(elements).toHaveLength(3);
    player.setPack({ ...pack, id: "another-theme", sounds: {} });
    expect(elements[2]!.src).toBe("");
    player.play("send");
    expect(elements).toHaveLength(3);
    player.stop();
  });
});
