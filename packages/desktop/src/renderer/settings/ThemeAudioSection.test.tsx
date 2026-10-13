import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import React, { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ensureMiniDom, flushMicrotasks } from "../test-utils/renderHook";
import { I18nProvider } from "../i18n";
import type { ThemePack } from "../theme-packs";
import { loadThemeAudioPreferences } from "../theme-audio";
import { ThemeAudioSection } from "./ThemeAudioSection";
import { themeMusic } from "../theme-music";
import { useThemeAudio } from "../app/useThemeAudio";

function descendants(node: Element): Element[] {
  return [node, ...Array.from(node.children).flatMap(descendants)];
}

function propsOf(node: Element): Record<string, any> {
  const key = Object.keys(node).find((name) => name.startsWith("__reactProps$"));
  return key ? (node as unknown as Record<string, any>)[key] : {};
}

class FakeAudio {
  static instances: FakeAudio[] = [];
  src = "";
  volume = 1;
  preload = "";
  loop = false;
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  pauses = 0;
  plays = 0;
  constructor() {
    FakeAudio.instances.push(this);
  }
  play() {
    this.plays += 1;
    return Promise.resolve();
  }
  pause() {
    this.pauses += 1;
  }
  load() {}
}

const theme: ThemePack = {
  id: "music-theme",
  name: "Music theme",
  swatch: "180 60% 50%",
  colors: { light: {}, dark: {} },
  sounds: { send: "cstheme://music-theme/send.wav" },
  music: [
    { title: "Original theme loop", file: "cstheme://music-theme/loop.wav" },
    { title: "Official listening", artist: "Artist", url: "https://example.com/official" },
  ],
};

describe("theme audio controls", () => {
  let root: Root;
  let container: HTMLElement;
  let restore: Array<() => void>;
  let opened: string[];
  let themeChanged: Set<() => void>;
  let revoked: string[];

  const replace = (object: object, key: string, value: unknown) => {
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    Object.defineProperty(object, key, { configurable: true, writable: true, value });
    restore.push(() => {
      if (descriptor) Object.defineProperty(object, key, descriptor);
      else Reflect.deleteProperty(object, key);
    });
  };

  beforeEach(() => {
    ensureMiniDom();
    restore = [];
    opened = [];
    revoked = [];
    themeChanged = new Set();
    themeMusic.dispose();
    FakeAudio.instances = [];
    const values = new Map<string, string>();
    replace(globalThis, "localStorage", {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    });
    replace(globalThis, "Audio", FakeAudio);
    replace(window, "codeshell", {
      openExternal: async (url: string) => {
        opened.push(url);
      },
      onThemesChanged: (listener: () => void) => {
        themeChanged.add(listener);
        return () => {
          themeChanged.delete(listener);
        };
      },
    });
    replace(URL, "createObjectURL", () => "blob:test-local-music");
    replace(URL, "revokeObjectURL", (url: string) => revoked.push(url));
    container = document.createElement("div");
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
      await flushMicrotasks();
    });
    themeMusic.dispose();
    for (const reset of restore.reverse()) reset();
  });

  const Owner = ({ pack, visible = true }: { pack: ThemePack; visible?: boolean }) => {
    useThemeAudio();
    useEffect(() => themeMusic.setPack(pack), [pack]);
    return visible ? <ThemeAudioSection key={pack.id} pack={pack} /> : null;
  };
  const render = async (pack = theme, visible = true) => {
    await act(async () => {
      root.render(
        <I18nProvider>
          <Owner pack={pack} visible={visible} />
        </I18nProvider>,
      );
      await flushMicrotasks();
    });
  };
  const element = (attr: string) =>
    descendants(container).find((node) => propsOf(node)[attr] !== undefined)!;
  const click = async (attr: string) => {
    await act(async () => {
      propsOf(element(attr)).onClick();
      await flushMicrotasks();
    });
  };
  const select = async (index: number) => {
    await act(async () => {
      propsOf(element("data-theme-music-select")).onChange({ target: { value: String(index) } });
      await flushMicrotasks();
    });
  };

  test("theme selection never auto-plays; preview is explicit and enable persists", async () => {
    await render();
    expect(FakeAudio.instances).toHaveLength(0);
    expect(opened).toEqual([]);
    expect(propsOf(element("data-theme-sounds-enabled")).checked).toBe(false);
    await click("data-theme-sound-preview");
    expect(FakeAudio.instances[0]!.src).toBe(theme.sounds!.send!);
    await act(async () => {
      propsOf(element("data-theme-sounds-enabled")).onChange({ target: { checked: true } });
      await flushMicrotasks();
    });
    expect(loadThemeAudioPreferences().enabled).toBe(true);
    expect(FakeAudio.instances[0]!.src).toBe("");
  });

  test("local tracks play, pause and resume; changing selection stops before opening an external link", async () => {
    await render();
    await click("data-theme-music-play");
    const audio = FakeAudio.instances[0]!;
    expect(audio.src).toBe(theme.music![0]!.file!);
    await click("data-theme-music-play");
    expect(audio.pauses).toBe(1);
    expect(audio.src).toBe(theme.music![0]!.file!);
    await click("data-theme-music-play");
    expect(audio.plays).toBe(2);
    await act(async () => {
      audio.onended?.();
      await flushMicrotasks();
    });
    expect(propsOf(element("data-theme-music-play")).disabled).toBe(false);
    await select(1);
    expect(audio.src).toBe("");
    expect(opened).toEqual([]);
    await click("data-theme-music-open");
    expect(opened).toEqual(["https://example.com/official"]);
    expect(FakeAudio.instances).toHaveLength(1);
  });

  test("uninstall notifications and theme changes stop playback immediately", async () => {
    await render();
    await click("data-theme-music-play");
    await act(async () => {
      for (const listener of themeChanged) listener();
      await flushMicrotasks();
    });
    expect(FakeAudio.instances[0]!.src).toBe("");
    await render();
    await act(async () => {
      themeMusic.setPack(theme);
      await flushMicrotasks();
    });
    await click("data-theme-music-play");
    await render({ ...theme, id: "new-theme" });
    expect(FakeAudio.instances[1]!.src).toBe("");
    expect(FakeAudio.instances).toHaveLength(2);
  });

  test("temporary music continues after leaving settings; App teardown stops and revokes it", async () => {
    await render();
    await act(async () => {
      propsOf(element("data-theme-music-import")).onChange({
        target: {
          files: [new File(["audio"], "my-song.mp3"), new File(["bad"], "not-a-song.txt")],
        },
      });
      await flushMicrotasks();
    });
    expect(FakeAudio.instances).toHaveLength(0);
    await select(2);
    await click("data-theme-music-play");
    expect(FakeAudio.instances[0]!.src).toBe("blob:test-local-music");
    await render(theme, false);
    expect(FakeAudio.instances[0]!.src).toBe("blob:test-local-music");
    expect(revoked).toEqual([]);
    await act(async () => {
      root.unmount();
      await flushMicrotasks();
    });
    expect(FakeAudio.instances[0]!.src).toBe("");
    expect(revoked).toEqual(["blob:test-local-music"]);
  });
});
