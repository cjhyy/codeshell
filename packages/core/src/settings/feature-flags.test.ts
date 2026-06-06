import { describe, test, expect } from "bun:test";
import {
  FEATURE_FLAGS,
  isFeatureEnabled,
  isKnownFeatureFlag,
  featureFlagNames,
  resolveFeatureFlags,
} from "./feature-flags.js";

// TODO §8.4 — Feature Flags system.

describe("feature flags", () => {
  test("isFeatureEnabled returns the compiled-in default when unset", () => {
    expect(isFeatureEnabled(undefined, "web_search")).toBe(FEATURE_FLAGS.web_search.default);
    expect(isFeatureEnabled({}, "undo")).toBe(FEATURE_FLAGS.undo.default);
    expect(isFeatureEnabled(undefined, "undo")).toBe(false);
    expect(isFeatureEnabled(undefined, "shell_tool")).toBe(true);
  });

  test("a settings override wins over the default", () => {
    expect(isFeatureEnabled({ shell_tool: false }, "shell_tool")).toBe(false);
    expect(isFeatureEnabled({ undo: true }, "undo")).toBe(true);
  });

  test("a non-boolean override is ignored (falls back to default)", () => {
    // Simulate corrupt settings where a flag isn't a boolean.
    const bad = { undo: "yes" } as unknown as Parameters<typeof isFeatureEnabled>[0];
    expect(isFeatureEnabled(bad, "undo")).toBe(FEATURE_FLAGS.undo.default);
  });

  test("isKnownFeatureFlag narrows known vs unknown names", () => {
    expect(isKnownFeatureFlag("web_search")).toBe(true);
    expect(isKnownFeatureFlag("not_a_flag")).toBe(false);
  });

  test("featureFlagNames lists every known flag", () => {
    expect(featureFlagNames().sort()).toEqual(
      ["fast_mode", "shell_snapshot", "shell_tool", "undo", "web_search"].sort(),
    );
  });

  test("resolveFeatureFlags merges defaults with overrides for every flag", () => {
    const resolved = resolveFeatureFlags({ undo: true, web_search: false });
    expect(resolved.undo).toBe(true); // overridden
    expect(resolved.web_search).toBe(false); // overridden
    expect(resolved.shell_tool).toBe(true); // default
    expect(resolved.fast_mode).toBe(false); // default
    // Every known flag is present in the resolved map.
    expect(Object.keys(resolved).sort()).toEqual(featureFlagNames().sort());
  });
});
