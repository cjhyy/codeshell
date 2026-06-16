/**
 * seedValue — the pure, testable core of useSettingsResource: pick the initial
 * value (cached snapshot if present, else fallback). The hook's effect wiring
 * (load + auto-listen files/settings-changed + cleanup) is a thin shell over
 * this; no DOM test infra here, so we lock the seed contract directly.
 */
import { describe, test, expect, afterEach } from "bun:test";
import { cacheSet } from "./settingsCache";
import { seedValue } from "./useSettingsResource";

const KEY = "test:seed";
afterEach(() => cacheSet(KEY, undefined));

describe("seedValue", () => {
  test("returns the cached snapshot when present", () => {
    cacheSet(KEY, [{ id: "a" }]);
    expect(seedValue(KEY, [])).toEqual([{ id: "a" }]);
  });

  test("returns the fallback when no cache", () => {
    expect(seedValue("test:absent", ["fb"])).toEqual(["fb"]);
  });

  test("returns undefined when no cache and no fallback", () => {
    expect(seedValue("test:absent2", undefined)).toBeUndefined();
  });

  test("cached value of any shape is returned as-is", () => {
    cacheSet(KEY, { defaults: { text: "x" } });
    expect(seedValue(KEY, undefined)).toEqual({ defaults: { text: "x" } });
  });
});
