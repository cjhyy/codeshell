import { describe, expect, it } from "bun:test";
import { nextPermissionMode, permissionConfigurePayload } from "./permission-mode.js";

describe("TUI permission mode cycling", () => {
  it("cycles plan → normal → bypass → plan", () => {
    expect(nextPermissionMode("plan")).toBe("normal");
    expect(nextPermissionMode("normal")).toBe("bypass");
    expect(nextPermissionMode("bypass")).toBe("plan");
  });

  it("sends the server permissionMode that actually changes tool behavior", () => {
    expect(permissionConfigurePayload("plan")).toEqual({
      planMode: true,
      permissionMode: "default",
    });
    expect(permissionConfigurePayload("normal")).toEqual({
      planMode: false,
      permissionMode: "acceptEdits",
    });
    expect(permissionConfigurePayload("bypass")).toEqual({
      planMode: false,
      permissionMode: "bypassPermissions",
    });
  });
});
