import { describe, it, expect } from "bun:test";
import { SettingsSchema } from "./schema.js";

describe("disabledAgents", () => {
  it("defaults to empty array", () => {
    const parsed = SettingsSchema.parse({});
    expect(parsed.disabledAgents).toEqual([]);
  });
  it("accepts an array of agent names", () => {
    const parsed = SettingsSchema.parse({ disabledAgents: ["explorer", "planner"] });
    expect(parsed.disabledAgents).toEqual(["explorer", "planner"]);
  });
});

describe("capabilityOverrides", () => {
  it("accepts tri-state buckets", () => {
    const parsed = SettingsSchema.parse({
      capabilityOverrides: {
        skills: { "superpowers:brainstorming": "off", helper: "on" },
        plugins: { superpowers: "off" },
        agents: { "my-agent": "on" },
        mcp: { playwright: "off" },
      },
    });
    expect(parsed.capabilityOverrides?.skills?.helper).toBe("on");
    expect(parsed.capabilityOverrides?.mcp?.playwright).toBe("off");
  });

  it("absent capabilityOverrides stays undefined (zero-regression)", () => {
    const parsed = SettingsSchema.parse({});
    expect(parsed.capabilityOverrides).toBeUndefined();
  });

  it("rejects unknown override value", () => {
    expect(() => SettingsSchema.parse({ capabilityOverrides: { skills: { a: "maybe" } } })).toThrow();
  });
});
