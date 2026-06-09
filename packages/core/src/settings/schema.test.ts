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

describe("mcpServers name resilience (regression: settings died on {\"23\":{no name}})", () => {
  it("backfills name from the record key when the value omits name", () => {
    // Reproduces the real corruption: desktop strips `name` and uses it as the
    // record key, but the schema previously required `name` and crashed on load.
    const parsed = SettingsSchema.parse({
      mcpServers: {
        "23": { transport: "stdio", command: "npx", enabled: false },
      },
    });
    expect(parsed.mcpServers["23"].name).toBe("23");
    expect(parsed.mcpServers["23"].command).toBe("npx");
  });

  it("keeps an explicit name when present", () => {
    const parsed = SettingsSchema.parse({
      mcpServers: { weather: { name: "weather", command: "npx" } },
    });
    expect(parsed.mcpServers.weather.name).toBe("weather");
  });

  it("normalizes a legacy array form into a name-keyed record", () => {
    const parsed = SettingsSchema.parse({
      mcpServers: [
        { name: "a", command: "x" },
        { name: "b", command: "y" },
      ],
    });
    expect(Object.keys(parsed.mcpServers).sort()).toEqual(["a", "b"]);
    expect(parsed.mcpServers.a.command).toBe("x");
  });
});
