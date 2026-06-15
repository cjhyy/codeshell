/**
 * Tests for per-bucket override persistence (permission / model / goal).
 *
 * Bug: permissionOverrides/modelOverrides were in-memory React state only, so a
 * renderer refresh (F5) wiped them and every session fell back to the default
 * mode/model — a full-access session silently reverted to 默认权限 on refresh.
 *
 * Fix: persist the override map to localStorage (mirrors loadPanelState/
 * savePanelState) and seed useState from it on mount. These pure helpers are
 * what App.tsx's useState initializer and the persist effect call.
 */
import { describe, it, expect, beforeEach } from "bun:test";
import { loadOverrideMap, saveOverrideMap } from "./transcripts";

type Mode = "default" | "bypassPermissions" | "acceptEdits";

class MemoryStorage {
  private data = new Map<string, string>();
  getItem(key: string): string | null {
    return this.data.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.data.set(key, value);
  }
  removeItem(key: string): void {
    this.data.delete(key);
  }
  clear(): void {
    this.data.clear();
  }
}

beforeEach(() => {
  Object.defineProperty(globalThis, "localStorage", {
    value: new MemoryStorage(),
    configurable: true,
  });
});

describe("saveOverrideMap / loadOverrideMap round-trip", () => {
  it("persists a bucket→value map and reads it back identically", () => {
    const map: Record<string, Mode> = {
      "repoA::s1": "bypassPermissions",
      "repoA::s2": "acceptEdits",
    };
    saveOverrideMap("permission", map);
    expect(loadOverrideMap<Mode>("permission")).toEqual(map);
  });

  it("survives a simulated refresh: a saved override is still there after a fresh load", () => {
    saveOverrideMap("permission", { "repoA::s1": "bypassPermissions" });
    // A refresh = a brand-new load with no in-memory state.
    const restored = loadOverrideMap<Mode>("permission");
    expect(restored["repoA::s1"]).toBe("bypassPermissions");
  });

  it("returns an empty object when nothing was saved", () => {
    expect(loadOverrideMap<Mode>("permission")).toEqual({});
  });

  it("clears the storage key when saving an empty map (no clutter)", () => {
    saveOverrideMap("permission", { "repoA::s1": "bypassPermissions" });
    saveOverrideMap("permission", {});
    expect(loadOverrideMap<Mode>("permission")).toEqual({});
    expect(localStorage.getItem("codeshell.overrides.permission")).toBeNull();
  });

  it("keeps separate namespaces (permission vs model) from colliding", () => {
    saveOverrideMap("permission", { "repoA::s1": "bypassPermissions" });
    saveOverrideMap("model", { "repoA::s1": "gpt-5.5" });
    expect(loadOverrideMap<Mode>("permission")).toEqual({ "repoA::s1": "bypassPermissions" });
    expect(loadOverrideMap<string>("model")).toEqual({ "repoA::s1": "gpt-5.5" });
  });

  it("returns an empty object on corrupt JSON instead of throwing", () => {
    localStorage.setItem("codeshell.overrides.permission", "{not json");
    expect(loadOverrideMap<Mode>("permission")).toEqual({});
  });

  it("strips the shared draft bucket (<repo>::_none_) so a draft choice never persists", () => {
    saveOverrideMap("permission", {
      "repoA::s1": "bypassPermissions",
      "repoA::_none_": "bypassPermissions", // draft slot — must not survive
    });
    const restored = loadOverrideMap<Mode>("permission");
    expect(restored["repoA::s1"]).toBe("bypassPermissions");
    expect(restored["repoA::_none_"]).toBeUndefined();
  });

  it("clears the key when the only override is a draft bucket", () => {
    saveOverrideMap("permission", { "repoA::_none_": "bypassPermissions" });
    expect(loadOverrideMap<Mode>("permission")).toEqual({});
    expect(localStorage.getItem("codeshell.overrides.permission")).toBeNull();
  });
});
