import { describe, expect, test } from "bun:test";
import { resolvePanelVisibility } from "./panelVisibility";

describe("resolvePanelVisibility", () => {
  test("session switches keep hidden panel lifecycles live without foreground ownership", () => {
    const sessionA = resolvePanelVisibility({
      hidden: false,
      keepActiveBodyLive: false,
      activeTab: true,
    });
    const sessionB = resolvePanelVisibility({
      hidden: true,
      keepActiveBodyLive: true,
      activeTab: true,
    });

    expect(sessionA).toEqual({ lifecycleVisible: true, foregroundVisible: true });
    expect(sessionB).toEqual({ lifecycleVisible: true, foregroundVisible: false });

    const switchedA = resolvePanelVisibility({
      hidden: true,
      keepActiveBodyLive: true,
      activeTab: true,
    });
    const switchedB = resolvePanelVisibility({
      hidden: false,
      keepActiveBodyLive: false,
      activeTab: true,
    });

    expect(switchedA.foregroundVisible).toBe(false);
    expect(switchedB.foregroundVisible).toBe(true);
  });
});
