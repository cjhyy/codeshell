import { describe, expect, it } from "bun:test";
import {
  toCorePermissionMode,
  fromSettingsPermissionMode,
} from "../packages/desktop/src/renderer/chat/PermissionPill";

describe("toCorePermissionMode", () => {
  it("maps each UI mode to its engine mode", () => {
    expect(toCorePermissionMode("plan")).toBe("plan");
    expect(toCorePermissionMode("default")).toBe("default");
    expect(toCorePermissionMode("accept_edits")).toBe("acceptEdits");
    // Goal mode → engine "auto" backend (auto-approve safe, deny
    // dangerous). This replaces the old bypassPermissions.
    expect(toCorePermissionMode("goal")).toBe("auto");
  });
});

describe("fromSettingsPermissionMode", () => {
  it("round-trips the live modes", () => {
    expect(fromSettingsPermissionMode("plan")).toBe("plan");
    expect(fromSettingsPermissionMode("default")).toBe("default");
    expect(fromSettingsPermissionMode("acceptEdits")).toBe("accept_edits");
    expect(fromSettingsPermissionMode("accept_edits")).toBe("accept_edits");
    expect(fromSettingsPermissionMode("auto")).toBe("goal");
    expect(fromSettingsPermissionMode("goal")).toBe("goal");
  });

  it("down-maps the dropped bypass mode to Goal (never honors raw bypass)", () => {
    // Legacy configs / sessions may still carry bypass; we must not
    // resurrect an unrestricted bypass — Goal is the safe landing.
    expect(fromSettingsPermissionMode("bypass")).toBe("goal");
    expect(fromSettingsPermissionMode("bypassPermissions")).toBe("goal");
  });

  it("falls back to default for unknown / missing values", () => {
    expect(fromSettingsPermissionMode(undefined)).toBe("default");
    expect(fromSettingsPermissionMode("nonsense")).toBe("default");
    expect(fromSettingsPermissionMode(null)).toBe("default");
  });
});
