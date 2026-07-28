import { describe, expect, test } from "bun:test";
import { nextDisabledPanelApps, panelAppProjectOverridePatch } from "./PanelsTab";

describe("Panel App controls", () => {
  const appId = "design-studio";

  test("global app toggle changes only the selected app denylist entry", () => {
    const other = "quant-lab";
    expect(nextDisabledPanelApps([other], appId, false)).toEqual([other, appId]);
    expect(nextDisabledPanelApps([other, appId], appId, true)).toEqual([other]);
  });

  test("global app toggle tolerates malformed settings values", () => {
    expect(nextDisabledPanelApps(undefined, appId, false)).toEqual([appId]);
    expect(nextDisabledPanelApps([42, appId, null], appId, true)).toEqual([]);
  });

  test("project policy uses on/off and deletes the key for inherit", () => {
    expect(panelAppProjectOverridePatch(appId, "on")).toEqual({
      panelAppOverrides: { [appId]: "on" },
    });
    expect(panelAppProjectOverridePatch(appId, "off")).toEqual({
      panelAppOverrides: { [appId]: "off" },
    });
    expect(panelAppProjectOverridePatch(appId, "inherit")).toEqual({
      panelAppOverrides: { [appId]: null },
    });
  });
});
