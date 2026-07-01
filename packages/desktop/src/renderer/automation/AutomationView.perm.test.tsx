import { describe, test, expect } from "bun:test";
import { PERMISSION_OPTIONS } from "./AutomationView";

describe("permission options carry tone aligned with chat severity", () => {
  test("each option has a tone; read-only=ok, workspace-write=warn, full=err", () => {
    const byVal = Object.fromEntries(PERMISSION_OPTIONS.map((p) => [p.value, p.tone]));
    expect(byVal["read-only"]).toBe("ok");
    expect(byVal["workspace-write"]).toBe("warn");
    expect(byVal["full"]).toBe("err");
    expect(PERMISSION_OPTIONS.every((p) => p.tone)).toBe(true);
  });
});
