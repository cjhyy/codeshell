import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ensureMiniDom } from "./test-utils/renderHook";
import { applyThemePack, loadThemePackId, saveThemePackId } from "./theme";

function packStyleText(): string {
  return document.getElementById("cs-theme-pack")?.textContent ?? "";
}

// The mini-DOM has no Storage; a minimal in-memory shim covers the pack id r/w.
function installLocalStorage(): void {
  const store = new Map<string, string>();
  (globalThis as unknown as { localStorage: Storage }).localStorage = {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => void store.set(key, String(value)),
    removeItem: (key) => void store.delete(key),
    clear: () => store.clear(),
    key: (index) => [...store.keys()][index] ?? null,
    get length() {
      return store.size;
    },
  } as Storage;
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
    expect(text).not.toContain("--cs-background");
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
