import { describe, expect, test } from "bun:test";
import { PLUGIN_PANEL_ICON_NAMES } from "../../shared/plugin-panels";
import { PanelTop } from "lucide-react";
import { resolvePluginPanelIcon } from "./pluginPanelIcons";

describe("resolvePluginPanelIcon", () => {
  test("maps every allowlisted name to a lucide component", () => {
    for (const name of PLUGIN_PANEL_ICON_NAMES) {
      expect(resolvePluginPanelIcon(name)).toBeDefined();
    }
  });

  test("keeps the v1 semantic aliases stable", () => {
    expect(resolvePluginPanelIcon("panel")).toBe(PanelTop);
    expect(resolvePluginPanelIcon("chart")).toBe(resolvePluginPanelIcon("bar-chart-3"));
    expect(resolvePluginPanelIcon("table")).toBe(resolvePluginPanelIcon("table-2"));
  });

  test("falls back to the generic panel icon for unknown names", () => {
    expect(resolvePluginPanelIcon("grid-3x3")).toBe(PanelTop);
    expect(resolvePluginPanelIcon("")).toBe(PanelTop);
  });
});
