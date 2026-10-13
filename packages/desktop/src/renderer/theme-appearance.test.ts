import { describe, expect, test } from "bun:test";
import { resolveThemeSurface } from "./theme-appearance";
import type { ThemePack } from "./theme-packs";

const basePack: ThemePack = {
  id: "appearance",
  name: "Appearance",
  swatch: "350 70% 50%",
  colors: { light: {}, dark: {} },
};

describe("resolveThemeSurface", () => {
  test("uses matching host defaults and accepts concrete preview palette values", () => {
    expect(resolveThemeSurface(basePack, "chat", "light").backgroundOpacity).toBe(0);
    expect(resolveThemeSurface(basePack, "titlebar", "light").backgroundOpacity).toBe(0.9);
    expect(resolveThemeSurface(basePack, "sidebar", "light")).toMatchObject({
      background: "var(--cs-muted)",
      backgroundOpacity: 0.25,
    });
    expect(
      resolveThemeSurface(basePack, "composer", "dark", { "--cs-card": "350 30% 10%" }).background,
    ).toBe("350 30% 10%");
  });

  test("an explicit chat background defaults to opaque in both appearance modes", () => {
    const pack: ThemePack = {
      ...basePack,
      surfaces: { chat: { background: { light: "350 60% 95%" } } },
    };
    for (const mode of ["light", "dark"] as const) {
      expect(resolveThemeSurface(pack, "chat", mode)).toMatchObject({
        background: "350 60% 95%",
        backgroundOpacity: 1,
      });
    }
  });

  test("an explicit background-only window suppresses the legacy wallpaper", () => {
    const pack: ThemePack = {
      ...basePack,
      wallpaper: { light: "cstheme://appearance/legacy.png", opacity: 0.4 },
      surfaces: { window: { background: { light: "350 60% 95%" } } },
    };
    for (const mode of ["light", "dark"] as const) {
      expect(resolveThemeSurface(pack, "window", mode)).toMatchObject({
        image: undefined,
        opacity: 0,
        backgroundOpacity: 1,
      });
    }
  });

  test("an explicit image defaults to its own opacity without borrowing the legacy one", () => {
    const pack: ThemePack = {
      ...basePack,
      wallpaper: { light: "cstheme://appearance/legacy.png", opacity: 0 },
      surfaces: { window: { light: "cstheme://appearance/window.png" } },
    };
    expect(resolveThemeSurface(pack, "window", "dark")).toMatchObject({
      image: "cstheme://appearance/window.png",
      opacity: 1,
    });
    expect(resolveThemeSurface({ ...pack, surfaces: undefined }, "window", "dark")).toMatchObject({
      image: "cstheme://appearance/legacy.png",
      opacity: 0,
    });
  });

  test("preserves explicit zero image and background opacity", () => {
    const pack: ThemePack = {
      ...basePack,
      surfaces: {
        chat: {
          light: "cstheme://appearance/chat.png",
          opacity: 0,
          background: { light: "350 60% 95%", dark: "350 40% 10%" },
          backgroundOpacity: 0,
          fit: "contain",
          position: "bottom-right",
        },
      },
    };
    expect(resolveThemeSurface(pack, "chat", "dark")).toMatchObject({
      image: "cstheme://appearance/chat.png",
      opacity: 0,
      background: "350 40% 10%",
      backgroundOpacity: 0,
      fit: "contain",
      position: "bottom right",
    });
  });
});
