import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ensureMiniDom, flushMicrotasks } from "../test-utils/renderHook";
import { I18nProvider } from "../i18n";
import { loadThemePackId } from "../theme";
import { AppearanceSection } from "./AppearanceSection";

function reactPropsOf(node: unknown): Record<string, any> {
  const current = node as Record<string, any>;
  const key = Object.keys(current).find((name) => name.startsWith("__reactProps$"));
  return key ? current[key] : {};
}

function findByAttr(node: unknown, attr: string): any[] {
  const current = node as { getAttribute?: (n: string) => string | null; childNodes?: unknown[] };
  const self = typeof current.getAttribute === "function" && current.getAttribute(attr) !== null;
  return [
    ...(self ? [current] : []),
    ...(current.childNodes ?? []).flatMap((child) => findByAttr(child, attr)),
  ];
}

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

let root: Root | null = null;

beforeEach(() => {
  ensureMiniDom();
  installLocalStorage();
});

afterEach(async () => {
  if (root) {
    await act(async () => {
      root?.unmount();
      await flushMicrotasks();
    });
  }
  root = null;
});

describe("AppearanceSection theme packs", () => {
  test("renders a card per built-in pack and selecting one persists + applies it", async () => {
    const container = document.createElement("div") as unknown as HTMLElement;
    root = createRoot(container);
    await act(async () => {
      root?.render(
        <I18nProvider>
          <AppearanceSection />
        </I18nProvider>,
      );
      await flushMicrotasks();
    });

    const packButtons = findByAttr(container, "data-theme-pack");
    const ids = packButtons.map((button) => button.getAttribute("data-theme-pack"));
    expect(ids).toEqual(["default", "ocean", "forest", "grape"]);

    const ocean = packButtons.find((button) => button.getAttribute("data-theme-pack") === "ocean");
    await act(async () => {
      reactPropsOf(ocean).onClick();
      await flushMicrotasks();
    });

    // Persisted to localStorage and reflected in the managed override style.
    expect(loadThemePackId()).toBe("ocean");
    expect(document.getElementById("cs-theme-pack")?.textContent).toContain(
      "--cs-primary: 210 80% 45%;",
    );
  });
});
