import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ensureMiniDom } from "./test-utils/renderHook";
import { applyThemePack, loadThemePackId, saveThemePackId } from "./theme";
import { THEME_SURFACE_NAMES, type ThemePack } from "./theme-packs";

function packStyleText(): string {
  return document.getElementById("cs-theme-pack")?.textContent ?? "";
}

// The mini-DOM has no Storage; a minimal in-memory shim covers the pack id r/w.
function installLocalStorage(): void {
  const store = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    writable: true,
    value: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, String(value)),
      removeItem: (key: string) => void store.delete(key),
      clear: () => store.clear(),
      key: (index: number) => [...store.keys()][index] ?? null,
      get length() {
        return store.size;
      },
    } satisfies Storage,
  });
}

function removePackStyle(): void {
  const node = document.getElementById("cs-theme-pack") as unknown as {
    parentNode?: { removeChild(child: unknown): void };
  } | null;
  node?.parentNode?.removeChild(node);
}

beforeEach(() => {
  ensureMiniDom();
  installLocalStorage();
  removePackStyle();
});

afterEach(removePackStyle);

describe("theme packs (theme.ts)", () => {
  test("applyThemePack writes :root + .dark override rules for an accent pack", () => {
    applyThemePack("ocean");
    const text = packStyleText();
    // Light override lands in :root, dark override in .dark.
    expect(text).toContain(":root {");
    expect(text).toContain("--cs-primary: 210 80% 45%;");
    expect(text).toContain(".dark {");
    expect(text).toContain("--cs-primary: 210 85% 60%;");
  });

  test("the default pack overrides no colors and clears any wallpaper", () => {
    applyThemePack("default");
    const text = packStyleText();
    // No color overrides…
    expect(text).not.toContain("--cs-primary");
    expect(text).not.toContain("--cs-background:");
    // …and wallpaper is explicitly cleared so switching away from a wallpaper
    // pack removes the image rather than leaving it painted.
    expect(text).toContain("--cs-wallpaper: none;");
    expect(text).toContain("--cs-wallpaper-opacity: 0;");
  });

  test("a pack with no wallpaper writes the cleared form in both selectors", () => {
    applyThemePack("ocean");
    expect(packStyleText().match(/--cs-wallpaper: none;/g)?.length).toBe(2);
  });

  test("applyThemePack emits an escaped wallpaper url + opacity when present", () => {
    applyThemePack("acme", () => ({
      id: "acme",
      name: "Acme",
      swatch: "0 0% 50%",
      colors: { light: {}, dark: {} },
      wallpaper: {
        light: 'cstheme://acme/bg"x.jpg',
        dark: "cstheme://acme/dark.jpg",
        opacity: 0.2,
      },
      source: "installed",
    }));
    const text = packStyleText();
    // Light selector gets the light url; the embedded quote is escaped.
    expect(text).toContain('--cs-wallpaper: url("cstheme://acme/bg\\"x.jpg");');
    expect(text).toContain('--cs-wallpaper: url("cstheme://acme/dark.jpg");');
    expect(text.match(/--cs-wallpaper-opacity: 0\.2;/g)?.length).toBe(2);
    expect(text).toContain('--cs-surface-window-image: url("cstheme://acme/bg\\"x.jpg");');
    expect(text).toContain('--cs-surface-window-image: url("cstheme://acme/dark.jpg");');
    expect(text.match(/--cs-surface-window-opacity: 0\.2;/g)?.length).toBe(2);
    expect(text.match(/--cs-surface-chat-background-opacity: 0;/g)?.length).toBe(2);
  });

  test("surface images and backgrounds fall back to light while dark overrides stay independent", () => {
    const pack: ThemePack = {
      id: "surfaces",
      name: "Surfaces",
      swatch: "350 80% 50%",
      colors: { light: {}, dark: {} },
      wallpaper: { light: "cstheme://surfaces/legacy.png" },
      surfaces: {
        window: { light: 'cstheme://surfaces/frame".png', opacity: 0.3 },
        chat: {
          light: "cstheme://surfaces/chat.png",
          fit: "contain",
          position: "top-right",
          background: { light: "350 60% 97%", dark: "350 40% 10%" },
          backgroundOpacity: 0.8,
        },
        composer: {
          dark: "cstheme://surfaces/composer-dark.png",
          background: { light: "350 80% 99%" },
        },
      },
      frame: { light: "350 70% 55%", dark: "350 80% 75%", width: 3, radius: 16 },
    };
    applyThemePack(pack.id, () => pack);
    const text = packStyleText();
    expect(
      text.match(/--cs-surface-window-image: url\("cstheme:\/\/surfaces\/frame\\"\.png"\);/g)
        ?.length,
    ).toBe(2);
    expect(
      text.match(/--cs-surface-chat-image: url\("cstheme:\/\/surfaces\/chat\.png"\);/g)?.length,
    ).toBe(2);
    expect(text.match(/--cs-surface-chat-fit: contain;/g)?.length).toBe(2);
    expect(text.match(/--cs-surface-chat-position: top right;/g)?.length).toBe(2);
    expect(text).toContain("--cs-surface-chat-background: 350 60% 97%;");
    expect(text).toContain("--cs-surface-chat-background: 350 40% 10%;");
    expect(text.match(/--cs-surface-chat-background-opacity: 0\.8;/g)?.length).toBe(2);
    expect(text).toContain("--cs-surface-composer-image: none;");
    expect(text).toContain(
      '--cs-surface-composer-image: url("cstheme://surfaces/composer-dark.png");',
    );
    expect(text.match(/--cs-surface-composer-background: 350 80% 99%;/g)?.length).toBe(2);
    expect(text).toContain("--cs-frame-color: 350 80% 75%;");
    expect(text).toContain("--cs-frame-width: 3px;");
    expect(text).toContain("--cs-frame-radius: 16px;");
  });

  test("switching to the default pack clears every image, placement, tint and frame", () => {
    applyThemePack("decorated", () => ({
      id: "decorated",
      name: "Decorated",
      swatch: "350 80% 50%",
      colors: { light: {}, dark: {} },
      surfaces: Object.fromEntries(
        THEME_SURFACE_NAMES.map((name) => [
          name,
          {
            light: `cstheme://decorated/${name}.png`,
            opacity: 0.6,
            fit: "contain",
            position: "bottom-right",
            background: { light: "350 50% 50%" },
            backgroundOpacity: 0.7,
          },
        ]),
      ),
      frame: { light: "350 70% 50%", width: 4, radius: 18 },
    }));
    applyThemePack("default");
    const text = packStyleText();
    for (const name of THEME_SURFACE_NAMES) {
      expect(text.match(new RegExp(`--cs-surface-${name}-image: none;`, "g"))?.length).toBe(2);
      expect(text.match(new RegExp(`--cs-surface-${name}-opacity: 0;`, "g"))?.length).toBe(2);
      expect(text).toContain(`--cs-surface-${name}-fit: cover;`);
      expect(text).toContain(`--cs-surface-${name}-position: center;`);
    }
    expect(text).not.toContain("decorated");
    expect(text).not.toContain("350 50% 50%");
    expect(text).toContain("--cs-surface-composer-background: var(--cs-card);");
    expect(text).toContain("--cs-frame-width: 0px;");
    expect(text).toContain("--cs-frame-radius: 0px;");
  });

  test("applyThemePack reuses one managed node and the latest apply wins", () => {
    applyThemePack("ocean");
    const first = document.getElementById("cs-theme-pack");
    applyThemePack("forest");
    const second = document.getElementById("cs-theme-pack");
    expect(second).toBe(first); // same node rewritten, not a new one
    expect(packStyleText()).toContain("--cs-primary: 150 55% 36%;");
    expect(packStyleText()).not.toContain("210 80% 45%");
  });

  test("re-applying the same pack keeps identical CSS (no needless repaint)", () => {
    // Re-applying the active pack (as a cross-window storage event does in every
    // window) must produce byte-identical CSS so the guard can skip the rewrite.
    applyThemePack("ocean");
    const first = packStyleText();
    applyThemePack("ocean");
    expect(packStyleText()).toBe(first);
  });

  test("loadThemePackId round-trips a valid id and falls back on an unknown one", () => {
    saveThemePackId("grape");
    expect(loadThemePackId()).toBe("grape");
    saveThemePackId("bogus");
    expect(loadThemePackId()).toBe("default");
  });
});
