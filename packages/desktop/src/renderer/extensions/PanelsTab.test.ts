import { describe, expect, test } from "bun:test";
import { nextPanelAppBindings } from "./PanelsTab";

describe("Panel App controls", () => {
  const appId = "design-studio";

  test("project binding adds and removes only the selected app", () => {
    expect(nextPanelAppBindings(["quant-lab"], appId, true)).toEqual([appId, "quant-lab"]);
    expect(nextPanelAppBindings(["quant-lab", appId], appId, false)).toEqual(["quant-lab"]);
    expect(nextPanelAppBindings([42, appId, null], appId, false)).toEqual([]);
  });
});
