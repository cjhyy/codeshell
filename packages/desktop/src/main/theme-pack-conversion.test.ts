import { describe, expect, test } from "bun:test";
import type { InstalledTheme } from "@cjhyy/code-shell-core";
import { installedThemeToPack } from "./theme-pack-conversion.js";

describe("installedThemeToPack", () => {
  test("converts all asset modes while preserving surface and frame appearance", () => {
    const theme: InstalledTheme = {
      id: "maki-theme",
      name: "Maki Theme",
      version: "1",
      colors: { light: {}, dark: { "--cs-primary": "350 75% 60%" } },
      pet: { idle: ".cs-theme-assets/pet-idle.png", walk: [".cs-theme-assets/pet-walk-1.gif"] },
      wallpaper: { light: ".cs-theme-assets/wallpaper-light.png", opacity: 0 },
      surfaces: {
        chat: {
          light: ".cs-theme-assets/surface-chat-light.png",
          dark: ".cs-theme-assets/surface-chat-dark.png",
          opacity: 0,
          fit: "contain",
          position: "top-right",
          background: { light: "350 70% 98%", dark: "350 25% 12%" },
          backgroundOpacity: 0.8,
        },
        composer: { background: { dark: "350 15% 20%" }, backgroundOpacity: 0 },
      },
      frame: { light: "350 60% 50%", dark: "350 50% 60%", width: 0, radius: 0 },
      sounds: {
        send: ".cs-theme-assets/sound-send.wav",
        error: ".cs-theme-assets/sound-error.wav",
      },
      music: [
        { title: "Local track", artist: "Artist", file: ".cs-theme-assets/music-1.wav" },
        { title: "Official listening", url: "https://example.com/listen" },
      ],
    };
    const before = JSON.stringify(theme);
    const pack = installedThemeToPack(theme);
    const prefix = "cstheme://maki-theme/";
    expect(pack.swatch).toBe("350 75% 60%");
    expect(pack.source).toBe("installed");
    expect(pack.pet).toEqual({
      idle: `${prefix}.cs-theme-assets/pet-idle.png`,
      walk: [`${prefix}.cs-theme-assets/pet-walk-1.gif`],
    });
    expect(pack.wallpaper).toEqual({
      light: `${prefix}.cs-theme-assets/wallpaper-light.png`,
      opacity: 0,
    });
    expect(pack.surfaces?.chat).toEqual({
      ...theme.surfaces?.chat,
      light: `${prefix}.cs-theme-assets/surface-chat-light.png`,
      dark: `${prefix}.cs-theme-assets/surface-chat-dark.png`,
    });
    expect(pack.surfaces?.composer).toEqual(theme.surfaces?.composer);
    expect(pack.frame).toEqual(theme.frame);
    expect(pack.sounds).toEqual({
      send: `${prefix}.cs-theme-assets/sound-send.wav`,
      error: `${prefix}.cs-theme-assets/sound-error.wav`,
    });
    expect(pack.music).toEqual([
      { title: "Local track", artist: "Artist", file: `${prefix}.cs-theme-assets/music-1.wav` },
      { title: "Official listening", url: "https://example.com/listen" },
    ]);
    expect(JSON.stringify(theme)).toBe(before);
  });

  test("legacy colors-only themes retain their renderer shape", () => {
    expect(
      installedThemeToPack({
        id: "just-colors",
        name: "Just Colors",
        version: "1",
        colors: { light: {}, dark: {} },
        pet: {},
      }),
    ).toEqual({
      id: "just-colors",
      name: "Just Colors",
      swatch: "0 0% 50%",
      colors: { light: {}, dark: {} },
      source: "installed",
    });
  });
});
