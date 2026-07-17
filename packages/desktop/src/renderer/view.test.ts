import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { BUILTIN_VIEW_MODES, loadView, saveView, type ViewState } from "./view";

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem" | "clear">;

function createStorage(): StorageLike {
  const items = new Map<string, string>();
  return {
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => {
      items.set(key, value);
    },
    removeItem: (key) => {
      items.delete(key);
    },
    clear: () => {
      items.clear();
    },
  };
}

describe("loadView", () => {
  const originalLocalStorage = globalThis.localStorage;

  beforeEach(() => {
    Object.defineProperty(globalThis, "localStorage", {
      value: createStorage(),
      configurable: true,
    });
  });

  afterEach(() => {
    Object.defineProperty(globalThis, "localStorage", {
      value: originalLocalStorage,
      configurable: true,
    });
  });

  function persist(viewMode: string): void {
    saveView({ viewMode, sidebarCollapsed: false, inspectorCollapsed: true } as ViewState);
  }

  it("returns the chat default when nothing is persisted", () => {
    expect(loadView().viewMode).toBe("chat");
  });

  it("keeps every builtin mode", () => {
    for (const mode of BUILTIN_VIEW_MODES) {
      persist(mode);
      expect(loadView().viewMode).toBe(mode);
    }
  });

  it("migrates the legacy customize and settings routes to the settings page", () => {
    persist("customize");
    expect(loadView().viewMode).toBe("settings_page");
    persist("settings");
    expect(loadView().viewMode).toBe("settings_page");
  });

  it("falls back to chat for an unknown persisted mode", () => {
    persist("files");
    expect(loadView().viewMode).toBe("chat");
    persist("page:foo@local:dash");
    expect(loadView().viewMode).toBe("chat");
  });

  it("keeps a non-builtin mode the registry predicate recognizes", () => {
    persist("page:foo@local:dash");
    expect(loadView((mode) => mode === "page:foo@local:dash").viewMode).toBe("page:foo@local:dash");
  });

  it("preserves the other persisted view flags", () => {
    persist("logs");
    const state = loadView();
    expect(state.inspectorCollapsed).toBe(true);
    expect(state.sidebarCollapsed).toBe(false);
  });
});
