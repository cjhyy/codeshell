import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ensureMiniDom, flushMicrotasks } from "../test-utils/renderHook";
import { I18nProvider } from "../i18n";
import { DialogProvider } from "../ui/DialogProvider";
import { loadThemePackId } from "../theme";
import { __setInstalledThemes } from "../installedThemes";
import { AppearanceSection } from "./AppearanceSection";

function wrap(node: React.ReactNode): React.ReactElement {
  return (
    <I18nProvider>
      <DialogProvider>{node}</DialogProvider>
    </I18nProvider>
  );
}

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

function findElements(node: unknown, tagName: string): any[] {
  const current = node as { tagName?: string; childNodes?: unknown[] };
  return [
    ...(current.tagName === tagName ? [current] : []),
    ...(current.childNodes ?? []).flatMap((child) => findElements(child, tagName)),
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
  __setInstalledThemes([]);
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
      root?.render(wrap(<AppearanceSection />));
      await flushMicrotasks();
    });

    const packCards = findByAttr(container, "data-theme-pack");
    const ids = packCards.map((card) => card.getAttribute("data-theme-pack"));
    expect(ids).toEqual(["default", "ocean", "forest", "grape"]);

    // The selectable control is the inner button of each card.
    const oceanCard = packCards.find((card) => card.getAttribute("data-theme-pack") === "ocean");
    const oceanButton = findElements(oceanCard, "BUTTON")[0];
    await act(async () => {
      reactPropsOf(oceanButton).onClick();
      await flushMicrotasks();
    });

    // Persisted to localStorage and reflected in the managed override style.
    expect(loadThemePackId()).toBe("ocean");
    expect(document.getElementById("cs-theme-pack")?.textContent).toContain(
      "--cs-primary: 210 80% 45%;",
    );
  });

  test("shows installed packs after the builtins with an uninstall control", async () => {
    __setInstalledThemes([
      {
        id: "acme-neon",
        name: "Acme Neon",
        swatch: "310 80% 50%",
        colors: { light: { "--cs-primary": "310 80% 50%" }, dark: {} },
        pet: { idle: "cstheme://acme-neon/.cs-theme-assets/pet-idle.png" },
        source: "installed",
      },
    ]);
    const container = document.createElement("div") as unknown as HTMLElement;
    root = createRoot(container);
    await act(async () => {
      root?.render(wrap(<AppearanceSection />));
      await flushMicrotasks();
    });

    const ids = findByAttr(container, "data-theme-pack").map((c) =>
      c.getAttribute("data-theme-pack"),
    );
    expect(ids).toEqual(["default", "ocean", "forest", "grape", "acme-neon"]);
    // Only the installed pack exposes an uninstall control.
    const uninstall = findByAttr(container, "data-theme-uninstall");
    expect(uninstall.map((b) => b.getAttribute("data-theme-uninstall"))).toEqual(["acme-neon"]);
  });
});
