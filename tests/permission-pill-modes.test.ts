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
    // 完全访问权限 = engine bypassPermissions backend (HeadlessApprovalBackend
    // "approve-all"). It's a permission LEVEL, distinct from Goal mode
    // (which is an orthogonal autonomy feature, not a pill entry).
    expect(toCorePermissionMode("bypass")).toBe("bypassPermissions");
  });
});

describe("fromSettingsPermissionMode", () => {
  it("round-trips the live modes", () => {
    expect(fromSettingsPermissionMode("plan")).toBe("plan");
    expect(fromSettingsPermissionMode("default")).toBe("default");
    expect(fromSettingsPermissionMode("acceptEdits")).toBe("accept_edits");
    expect(fromSettingsPermissionMode("accept_edits")).toBe("accept_edits");
    expect(fromSettingsPermissionMode("bypass")).toBe("bypass");
    expect(fromSettingsPermissionMode("bypassPermissions")).toBe("bypass");
  });

  it("down-maps the short-lived goal/auto permission values to default", () => {
    // Commit 58e6114 briefly wrote permissionMode="goal" (mapped to the
    // engine "auto" backend) into session overrides / settings. Goal is
    // no longer a permission value — it's an orthogonal autonomy toggle.
    // Residual "goal"/"auto" downgrade to default (ask), NOT bypass: we
    // never silently hand a user full-access from a stale config.
    expect(fromSettingsPermissionMode("goal")).toBe("default");
    expect(fromSettingsPermissionMode("auto")).toBe("default");
  });

  it("falls back to default for unknown / missing values", () => {
    expect(fromSettingsPermissionMode(undefined)).toBe("default");
    expect(fromSettingsPermissionMode("nonsense")).toBe("default");
    expect(fromSettingsPermissionMode(null)).toBe("default");
  });
});
