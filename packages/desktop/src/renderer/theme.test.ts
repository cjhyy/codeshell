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

  test("the default pack writes empty rules (falls through to the base sheet)", () => {
    applyThemePack("default");
    // No variable overrides — just the two empty selectors.
    expect(packStyleText()).not.toContain("--cs-");
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

  test("loadThemePackId round-trips a valid id and falls back on an unknown one", () => {
    saveThemePackId("grape");
    expect(loadThemePackId()).toBe("grape");
    saveThemePackId("bogus");
    expect(loadThemePackId()).toBe("default");
  });
});
