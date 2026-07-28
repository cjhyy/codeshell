import { describe, expect, test } from "bun:test";
import { PanelTop } from "lucide-react";
import { PANEL_APP_ICON_NAMES } from "../../shared/panel-apps";
import { resolvePanelAppIcon } from "./panelAppIcons";

describe("resolvePanelAppIcon", () => {
  test("maps every allowlisted name to a lucide component", () => {
    for (const name of PANEL_APP_ICON_NAMES) {
      expect(resolvePanelAppIcon(name)).toBeDefined();
    }
  });

  test("keeps the semantic aliases stable", () => {
    expect(resolvePanelAppIcon("panel")).toBe(PanelTop);
    expect(resolvePanelAppIcon("chart")).toBe(resolvePanelAppIcon("bar-chart-3"));
    expect(resolvePanelAppIcon("table")).toBeDefined();
  });

  test("falls back to the generic panel icon for unknown names", () => {
    expect(resolvePanelAppIcon("grid-3x3")).toBe(PanelTop);
    expect(resolvePanelAppIcon("")).toBe(PanelTop);
  });
});
