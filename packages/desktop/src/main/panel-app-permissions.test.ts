import { describe, expect, test } from "bun:test";
import { PANEL_APP_PERMISSIONS } from "../../../core/src/panel-apps/manifest.js";
import { PANEL_APP_PERMISSION_NAMES } from "../shared/panel-apps.js";

describe("Panel App Host permissions", () => {
  test("keeps Desktop wire permissions aligned with the Core manifest", () => {
    expect([...PANEL_APP_PERMISSION_NAMES].sort()).toEqual([...PANEL_APP_PERMISSIONS].sort());
  });
});
