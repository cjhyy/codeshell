import { describe, expect, test } from "bun:test";
import { PLUGIN_PANEL_ICONS } from "@cjhyy/code-shell-core";
import { PLUGIN_PANEL_ICON_NAMES } from "../shared/plugin-panels.js";

describe("plugin panel icon allowlist", () => {
  test("desktop and core agree on the exact allowlist", () => {
    expect([...PLUGIN_PANEL_ICON_NAMES].sort()).toEqual([...PLUGIN_PANEL_ICONS].sort());
  });

  test("stays within the 50-100 explicit-name budget", () => {
    expect(PLUGIN_PANEL_ICON_NAMES.length).toBeGreaterThanOrEqual(50);
    expect(PLUGIN_PANEL_ICON_NAMES.length).toBeLessThanOrEqual(100);
  });
});
