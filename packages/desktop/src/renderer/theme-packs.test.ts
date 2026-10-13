import { describe, expect, test } from "bun:test";
import makiManifest from "../../../../examples/themes/lovelive-maki/.cs-theme.json";
import {
  DEFAULT_PACK_ID,
  THEME_PACKS,
  THEME_VAR_NAMES,
  THEME_SURFACE_NAMES,
  getThemePack,
  petVisualState,
} from "./theme-packs";

const VAR_SET = new Set<string>(THEME_VAR_NAMES);
const HSL = /^\d+(?:\.\d+)?\s+\d+(?:\.\d+)?%\s+\d+(?:\.\d+)?%$/;

describe("theme-packs", () => {
  test("has a default pack that overrides nothing", () => {
    const base = getThemePack(DEFAULT_PACK_ID);
    expect(base.id).toBe("default");
    expect(Object.keys(base.colors.light)).toHaveLength(0);
    expect(Object.keys(base.colors.dark)).toHaveLength(0);
  });

  test("every pack overrides only whitelisted variables with valid HSL values", () => {
    for (const pack of THEME_PACKS) {
      for (const mode of ["light", "dark"] as const) {
        for (const [name, value] of Object.entries(pack.colors[mode])) {
          expect(VAR_SET.has(name)).toBe(true);
          expect(value).toMatch(HSL);
        }
      }
      expect(pack.swatch).toMatch(HSL);
    }
  });

  test("pack ids are unique and the first entry is the default", () => {
    const ids = THEME_PACKS.map((pack) => pack.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(THEME_PACKS[0]?.id).toBe(DEFAULT_PACK_ID);
  });

  test("getThemePack falls back to the default for an unknown id", () => {
    expect(getThemePack("nope").id).toBe(DEFAULT_PACK_ID);
  });

  test("builtin packs are tagged as builtin", () => {
    for (const pack of THEME_PACKS) expect(pack.source).toBe("builtin");
  });

  test("bundled Maki preserves the source palette, six surfaces and frame with local artwork", async () => {
    const maki = getThemePack("maki");
    expect(maki.id).not.toBe(makiManifest.id);
    expect(maki.name).toBe("settingsX.appearance.pack.maki");
    expect(maki.colors).toEqual(makiManifest.colors);
    expect(maki.frame).toEqual(makiManifest.frame);
    expect(Object.keys(maki.surfaces ?? {}).sort()).toEqual([...THEME_SURFACE_NAMES].sort());
    const images = new Set<string>();
    for (const name of THEME_SURFACE_NAMES) {
      const surface = maki.surfaces?.[name];
      const { light, dark, ...decoration } = surface!;
      const {
        light: sourceLight,
        dark: sourceDark,
        ...sourceDecoration
      } = makiManifest.surfaces[name] as { light?: string; dark?: string };
      expect(decoration).toEqual(sourceDecoration);
      for (const [url, source] of [
        [light, sourceLight],
        [dark, sourceDark],
      ]) {
        expect(Boolean(url)).toBe(Boolean(source));
        if (url) images.add(url);
      }
    }
    expect(maki.wallpaper?.opacity).toBe(makiManifest.wallpaper.opacity);
    images.add(maki.wallpaper!.light!);
    images.add(maki.wallpaper!.dark!);
    expect(images.size).toBe(2);
    for (const url of images) {
      expect(url).not.toMatch(/^(?:https?:|cstheme:)/i);
      const bytes = await Bun.file(url).bytes();
      expect([...bytes.slice(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    }
  });

  test("petVisualState prefers running, then alert, else idle", () => {
    expect(petVisualState({})).toBe("idle");
    expect(petVisualState({ alertCount: 2 })).toBe("alert");
    expect(petVisualState({ runningCount: 1 })).toBe("running");
    // running wins over a simultaneous alert
    expect(petVisualState({ runningCount: 1, alertCount: 3 })).toBe("running");
  });

  test("a greeting cue waves only when otherwise idle", () => {
    expect(petVisualState({ greeting: true })).toBe("waving");
    // work or an alert outranks the idle wave
    expect(petVisualState({ greeting: true, runningCount: 1 })).toBe("running");
    expect(petVisualState({ greeting: true, alertCount: 1 })).toBe("alert");
  });
});
