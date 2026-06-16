/**
 * resolveAuxKey — which pool key the background/aux client uses. The unified
 * store writes settings.defaults.auxText (a connection id = pool key); the
 * legacy field is settings.auxModelKey. Unified wins; legacy is the fallback.
 * See docs/superpowers/specs/2026-06-15-unified-model-catalog-design.md §6.
 */
import { describe, test, expect } from "bun:test";
import { resolveAuxKey } from "./aux-key.js";

describe("resolveAuxKey", () => {
  test("prefers defaults.auxText (unified store)", () => {
    expect(resolveAuxKey({ defaults: { auxText: "my-mini" }, auxModelKey: "legacy" })).toBe("my-mini");
  });

  test("falls back to legacy auxModelKey when defaults.auxText is unset", () => {
    expect(resolveAuxKey({ auxModelKey: "legacy-aux" })).toBe("legacy-aux");
  });

  test("returns undefined when neither is set", () => {
    expect(resolveAuxKey({})).toBeUndefined();
    expect(resolveAuxKey({ defaults: {} })).toBeUndefined();
  });

  test("ignores empty strings", () => {
    expect(resolveAuxKey({ defaults: { auxText: "" }, auxModelKey: "legacy" })).toBe("legacy");
    expect(resolveAuxKey({ defaults: { auxText: "" }, auxModelKey: "" })).toBeUndefined();
  });
});
