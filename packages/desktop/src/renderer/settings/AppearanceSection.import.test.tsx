import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ThemeImportKind, ThemePickPreview } from "../../shared/theme-packs";
import { ensureMiniDom, flushMicrotasks } from "../test-utils/renderHook";
import { DialogProvider } from "../ui/DialogProvider";
import { AppearanceSection } from "./AppearanceSection";

function descendants(node: Element): Element[] {
  return [node, ...Array.from(node.children).flatMap(descendants)];
}

function propsOf(node: Element): Record<string, any> {
  const key = Object.keys(node).find((name) => name.startsWith("__reactProps$"));
  return key ? (node as unknown as Record<string, any>)[key] : {};
}

describe("AppearanceSection theme import", () => {
  let root: Root;
  let container: HTMLElement;
  let stored: Map<string, string>;
  let pick: (kind?: ThemeImportKind) => Promise<ThemePickPreview>;
  let pickedKinds: Array<ThemeImportKind | undefined>;
  let installs: unknown[];
  let restore: Array<() => void>;

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
    stored = new Map();
    pickedKinds = [];
    installs = [];
    pick = async () => ({ cancelled: true });
    replace(globalThis, "localStorage", {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => stored.set(key, value),
    });
    replace(window, "codeshell", {
      listInstalledThemes: async () => [],
      pickAndPreviewTheme: (kind?: ThemeImportKind) => {
        pickedKinds.push(kind);
        return pick(kind);
      },
      installTheme: async (input: unknown) => {
        installs.push(input);
        throw new Error("Unexpected installation");
      },
    });
    container = document.createElement("div");
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
      await flushMicrotasks();
    });
    for (const reset of restore.reverse()) reset();
  });

  const render = async () => {
    await act(async () => {
      root.render(
        <DialogProvider>
          <AppearanceSection />
        </DialogProvider>,
      );
      await flushMicrotasks();
    });
  };
  const button = (attribute: string) =>
    descendants(container).find(
      (node) => node.tagName === "BUTTON" && propsOf(node)[attribute] !== undefined,
    )!;
  const click = async (attribute: string) => {
    await act(async () => {
      propsOf(button(attribute)).onClick();
      await flushMicrotasks();
    });
  };

  test("ZIP action opens the ZIP chooser and cancellation does not install or activate a pack", async () => {
    await render();
    await click("data-theme-import");
    expect(pickedKinds).toEqual(["zip"]);
    expect(installs).toEqual([]);
    expect(stored.has("codeshell.theme-pack")).toBe(false);
    expect(propsOf(button("data-theme-import")).disabled).toBe(false);
  });

  test("folder action opens the separate directory chooser", async () => {
    await render();
    await click("data-theme-import-directory");
    expect(pickedKinds).toEqual(["directory"]);
    expect(installs).toEqual([]);
  });

  test("both import actions stay disabled while the native picker is open", async () => {
    let finish!: (result: ThemePickPreview) => void;
    pick = () => new Promise((resolve) => (finish = resolve));
    await render();
    await click("data-theme-import");
    expect(propsOf(button("data-theme-import")).disabled).toBe(true);
    expect(propsOf(button("data-theme-import-directory")).disabled).toBe(true);
    await act(async () => {
      finish({ cancelled: true });
      await flushMicrotasks();
    });
    expect(propsOf(button("data-theme-import-directory")).disabled).toBe(false);
    expect(installs).toEqual([]);
  });
});
