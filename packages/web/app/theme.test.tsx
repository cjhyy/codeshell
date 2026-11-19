import { describe, expect, test } from "bun:test";
import React from "react";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import {
  applyThemePreference,
  loadThemePreference,
  parseThemePreference,
  resolveTheme,
  saveThemePreference,
  THEME_COLORS,
  THEME_STORAGE_KEY,
} from "./theme.js";
import { ThemeToggle } from "./ThemeToggle.js";

class MemoryStorage {
  readonly values = new Map<string, string>();
  getItem(key: string) {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
  removeItem(key: string) {
    this.values.delete(key);
  }
}

function fakeDocument() {
  const metas = [
    { media: "(prefers-color-scheme: light)", content: "" },
    { media: "(prefers-color-scheme: dark)", content: "" },
  ];
  const doc = {
    documentElement: { dataset: {} as Record<string, string | undefined> },
    querySelectorAll: () => metas,
  };
  return { doc: doc as unknown as Document, root: doc.documentElement, metas };
}

describe("theme preference", () => {
  test("only light and dark are explicit; anything else means system", () => {
    expect(parseThemePreference("light")).toBe("light");
    expect(parseThemePreference("dark")).toBe("dark");
    expect(parseThemePreference("solarized")).toBe("system");
    expect(parseThemePreference(null)).toBe("system");
  });

  test("persists explicit choices and clears the key for system", () => {
    const storage = new MemoryStorage();
    expect(loadThemePreference(storage)).toBe("system");
    saveThemePreference("dark", storage);
    expect(storage.values.get(THEME_STORAGE_KEY)).toBe("dark");
    expect(loadThemePreference(storage)).toBe("dark");
    saveThemePreference("system", storage);
    expect(storage.values.has(THEME_STORAGE_KEY)).toBe(false);
  });

  test("storage failures fall back to system without throwing", () => {
    const broken = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
      removeItem: () => {},
    };
    expect(loadThemePreference(broken)).toBe("system");
    expect(() => saveThemePreference("dark", broken)).not.toThrow();
  });

  test("system follows the OS preference; explicit choices ignore it", () => {
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("dark", false)).toBe("dark");
  });

  test("applies data-theme and theme-color, and system restores both", () => {
    const { doc, root, metas } = fakeDocument();
    applyThemePreference("dark", doc);
    expect(root.dataset.theme).toBe("dark");
    expect(metas.map((meta) => meta.content)).toEqual([THEME_COLORS.dark, THEME_COLORS.dark]);
    applyThemePreference("light", doc);
    expect(root.dataset.theme).toBe("light");
    expect(metas.map((meta) => meta.content)).toEqual([THEME_COLORS.light, THEME_COLORS.light]);
    applyThemePreference("system", doc);
    expect("theme" in root.dataset).toBe(false);
    expect(metas.map((meta) => meta.content)).toEqual([THEME_COLORS.light, THEME_COLORS.dark]);
  });

  test("app.css keeps the dark palette for both data-theme and the system preference", () => {
    const css = readFileSync(new URL("./app.css", import.meta.url), "utf8");
    expect(css).toContain(':root[data-theme="dark"] {');
    expect(css).toContain(':root:not([data-theme="light"]) {');
    const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");
    // index.html's media-scoped colours must equal THEME_COLORS so "system" restores them.
    expect(html).toContain(`content="${THEME_COLORS.light}"`);
    expect(html).toContain(`content="${THEME_COLORS.dark}"`);
  });

  test("the toggle offers system, light and dark with the stored choice pressed", () => {
    const markup = renderToStaticMarkup(<ThemeToggle />);
    expect(markup).toContain('role="group"');
    expect(markup).toContain('aria-label="外观"');
    for (const label of ["跟随系统", "浅色", "深色"])
      expect(markup).toContain(`aria-label="${label}"`);
    // No stored choice in the test environment: system is the pressed option.
    expect(markup).toMatch(/aria-pressed="true" aria-label="跟随系统"/);
  });
});
