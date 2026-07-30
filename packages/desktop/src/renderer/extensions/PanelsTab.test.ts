import { describe, expect, test } from "bun:test";
import { nextDisabledPanelApps, nextPanelAppBindings } from "./PanelsTab";

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

  test("project binding adds and removes only the selected app", () => {
    expect(nextPanelAppBindings(["quant-lab"], appId, true)).toEqual([appId, "quant-lab"]);
    expect(nextPanelAppBindings(["quant-lab", appId], appId, false)).toEqual(["quant-lab"]);
    expect(nextPanelAppBindings([42, appId, null], appId, false)).toEqual([]);
  });
});
