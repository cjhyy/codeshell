import { describe, expect, test } from "bun:test";
import { ThemeAudioPlayback, type ThemeAudioElement } from "./theme-audio";
import { ThemeMusicStore } from "./theme-music";
import type { ThemePack } from "./theme-packs";

const pack: ThemePack = {
  id: "test-music",
  name: "Music",
  swatch: "180 60% 50%",
  colors: { light: {}, dark: {} },
  music: [
    { title: "Official intro", url: "https://example.com/intro" },
    { title: "Loop", file: "cstheme://test-music/loop.wav" },
    { title: "Official", url: "https://example.com/official" },
    { title: "Empty file", file: "  ", url: "https://example.com/empty" },
    { title: "Another loop", file: "cstheme://test-music/another.wav" },
  ],
};

function audio(play: () => Promise<void> = async () => {}): ThemeAudioElement {
  return {
    src: "",
    volume: 1,
    preload: "",
    loop: false,
    play,
    pause() {},
    load() {},
    onended: null,
    onerror: null,
  };
}

describe("App-owned theme music", () => {
  test("switching themes during a delayed play cannot revive old playback", async () => {
    let settle!: () => void;
    const element = audio(
      () =>
        new Promise((resolve) => {
          settle = resolve;
        }),
    );
    const store = new ThemeMusicStore(new ThemeAudioPlayback(() => element));
    store.setPack(pack);
    const pending = store.toggle();
    expect(store.getSnapshot().pending).toBe(true);
    store.setPack({ ...pack, id: "replacement", music: [] });
    expect(element.src).toBe("");
    settle();
    await pending;
    expect(store.getSnapshot()).toMatchObject({
      packId: "replacement",
      playing: false,
      pending: false,
      active: false,
      tracks: [],
      error: null,
    });
    store.dispose();
  });

  test("repeat is explicit, pause retains a track, and next skips external links", async () => {
    let plays = 0;
    const element = audio(async () => {
      plays += 1;
    });
    const store = new ThemeMusicStore(new ThemeAudioPlayback(() => element));
    store.setPack(pack);
    expect(store.getSnapshot().tracks.map((track) => track.title)).toEqual([
      "Loop",
      "Another loop",
    ]);
    expect(plays).toBe(0);
    await store.toggle();
    expect(element.loop).toBe(true);
    store.setRepeat(false);
    expect(element.loop).toBe(false);
    await store.toggle();
    expect(store.getSnapshot()).toMatchObject({ active: true, playing: false });
    expect(element.src).toBe("cstheme://test-music/loop.wav");
    await store.toggle();
    expect(plays).toBe(2);
    store.next();
    expect(store.getSnapshot().selected).toBe(1);
    expect(plays).toBe(2);
    expect(element.src).toBe("");
    await store.toggle();
    expect(plays).toBe(3);
    expect(element.src).toBe("cstheme://test-music/another.wav");
    store.next();
    expect(store.getSnapshot().selected).toBe(0);
    store.dispose();
  });

  test("an all-external pack has an empty playlist and cannot start playback", async () => {
    let plays = 0;
    const store = new ThemeMusicStore(
      new ThemeAudioPlayback(() =>
        audio(async () => {
          plays += 1;
        }),
      ),
    );
    store.setPack({ ...pack, music: pack.music!.filter((track) => !track.file?.trim()) });
    store.next();
    await store.toggle();
    expect(store.getSnapshot()).toMatchObject({
      tracks: [],
      selected: 0,
      active: false,
      playing: false,
      pending: false,
      error: null,
    });
    expect(plays).toBe(0);
    store.dispose();
  });

  test("a disposed player ignores a late rejected play promise", async () => {
    let reject!: (error: Error) => void;
    const element = audio(
      () =>
        new Promise((_resolve, fail) => {
          reject = fail;
        }),
    );
    const store = new ThemeMusicStore(new ThemeAudioPlayback(() => element));
    store.setPack(pack);
    const pending = store.toggle();
    store.dispose();
    reject(new Error("unmounted"));
    await pending;
    expect(store.getSnapshot()).toMatchObject({
      packId: "",
      playing: false,
      pending: false,
      active: false,
      error: null,
    });
    expect(element.src).toBe("");
  });
});
