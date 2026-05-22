import { describe, it, expect } from "bun:test";
import { validateSettings } from "../packages/core/src/settings/schema.js";

// Smoke tests for the settings.hooks schema added for P3-A.
// Full Settings shape is exercised by settings-schema.test.ts;
// here we only cover the hooks-specific surface.
describe("settings.hooks schema", () => {
  it("accepts a minimal hook entry", () => {
    const out = validateSettings({
      hooks: [{ event: "pre_tool_use", command: "echo" }],
    });
    expect(out.hooks).toEqual([{ event: "pre_tool_use", command: "echo" }]);
  });

  it("accepts full entry with matcher / timeout / cwd", () => {
    const out = validateSettings({
      hooks: [
        {
          event: "pre_tool_use",
          command: "/usr/local/bin/lint.sh",
          matcher: "Edit|Write",
          timeout_ms: 5000,
          cwd: "/tmp/proj",
        },
      ],
    });
    expect(out.hooks?.[0]?.matcher).toBe("Edit|Write");
    expect(out.hooks?.[0]?.timeout_ms).toBe(5000);
    expect(out.hooks?.[0]?.cwd).toBe("/tmp/proj");
  });

  it("rejects empty command", () => {
    expect(() =>
      validateSettings({ hooks: [{ event: "pre_tool_use", command: "" }] }),
    ).toThrow();
  });

  it("rejects negative / zero / non-integer timeout", () => {
    expect(() =>
      validateSettings({ hooks: [{ event: "x", command: "y", timeout_ms: -1 }] }),
    ).toThrow();
    expect(() =>
      validateSettings({ hooks: [{ event: "x", command: "y", timeout_ms: 0 }] }),
    ).toThrow();
    expect(() =>
      validateSettings({ hooks: [{ event: "x", command: "y", timeout_ms: 1.5 }] }),
    ).toThrow();
  });

  it("allows missing event but rejects non-string event", () => {
    // event MUST be a string — runner ignores unknown event names at register time
    // (so a stale `event: "old_name"` is non-fatal), but the type must still be a string.
    expect(() =>
      validateSettings({ hooks: [{ event: 42, command: "y" }] as never }),
    ).toThrow();
  });

  it("missing `hooks` field is fine", () => {
    const out = validateSettings({});
    expect(out.hooks).toBeUndefined();
  });
});
