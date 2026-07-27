import { describe, expect, test } from "bun:test";
import {
  DEFAULT_PACK_ID,
  THEME_PACKS,
  THEME_VAR_NAMES,
  getThemePack,
  petVisualState,
} from "./theme-packs";

const VAR_SET = new Set<string>(THEME_VAR_NAMES);
const HSL = /^\d+(?:\.\d+)?\s+\d+(?:\.\d+)?%\s+\d+(?:\.\d+)?%$/;

describe("theme-packs", () => {
  test("has a default pack that overrides nothing", () => {
    const base = getThemePack(DEFAULT_PACK_ID);
    expect(base.id).toBe("default");
    expect(Object.keys(base.colors.light)).toHaveLength(0);
    expect(Object.keys(base.colors.dark)).toHaveLength(0);
  });

  test("every pack overrides only whitelisted variables with valid HSL values", () => {
    for (const pack of THEME_PACKS) {
      for (const mode of ["light", "dark"] as const) {
        for (const [name, value] of Object.entries(pack.colors[mode])) {
          expect(VAR_SET.has(name)).toBe(true);
          expect(value).toMatch(HSL);
        }
      }
      expect(pack.swatch).toMatch(HSL);
    }
  });

  test("pack ids are unique and the first entry is the default", () => {
    const ids = THEME_PACKS.map((pack) => pack.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(THEME_PACKS[0]?.id).toBe(DEFAULT_PACK_ID);
  });

  test("getThemePack falls back to the default for an unknown id", () => {
    expect(getThemePack("nope").id).toBe(DEFAULT_PACK_ID);
  });

  test("builtin packs are tagged as builtin", () => {
    for (const pack of THEME_PACKS) expect(pack.source).toBe("builtin");
  });

  test("petVisualState prefers running, then alert, else idle", () => {
    expect(petVisualState({})).toBe("idle");
    expect(petVisualState({ alertCount: 2 })).toBe("alert");
    expect(petVisualState({ runningCount: 1 })).toBe("running");
    // running wins over a simultaneous alert
    expect(petVisualState({ runningCount: 1, alertCount: 3 })).toBe("running");
  });

  test("a greeting cue waves only when otherwise idle", () => {
    expect(petVisualState({ greeting: true })).toBe("waving");
    // work or an alert outranks the idle wave
    expect(petVisualState({ greeting: true, runningCount: 1 })).toBe("running");
    expect(petVisualState({ greeting: true, alertCount: 1 })).toBe("alert");
  });
});
