import { describe, expect, test } from "bun:test";
import { shouldShowPanelDockFallback } from "./appUtils";

describe("panel dock lazy fallback visibility", () => {
  test("does not flash a retained but closed panel during startup", () => {
    expect(shouldShowPanelDockFallback(false, true)).toBe(false);
  });

  test("shows loading only when the active chat dock is actually open", () => {
    expect(shouldShowPanelDockFallback(true, true)).toBe(true);
    expect(shouldShowPanelDockFallback(true, false)).toBe(false);
  });
});
