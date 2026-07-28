import { describe, expect, test } from "bun:test";
import { PANEL_APP_ICONS } from "@cjhyy/code-shell-core";
import { PANEL_APP_ICON_NAMES } from "../shared/panel-apps.js";

describe("Panel App icon allowlist", () => {
  test("desktop and core agree on the exact allowlist", () => {
    expect([...PANEL_APP_ICON_NAMES].sort()).toEqual([...PANEL_APP_ICONS].sort());
  });

  test("stays intentionally compact", () => {
    expect(PANEL_APP_ICON_NAMES.length).toBeGreaterThanOrEqual(10);
    expect(PANEL_APP_ICON_NAMES.length).toBeLessThanOrEqual(20);
  });
});
