import { describe, it, expect } from "bun:test";
import { SettingsSchema, validateSettings } from "./schema.js";

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

  it("preserves credentialRef through validation (binding must survive round-trip)", () => {
    const parsed = SettingsSchema.parse({
      mcpServers: {
        figma: { transport: "streamable-http", url: "https://x/mcp", credentialRef: "my-figma-token" },
      },
    });
    expect(parsed.mcpServers.figma.credentialRef).toBe("my-figma-token");
  });
});

describe("validateSettings · reasoning effort (regression: boot crashed on unknown effort)", () => {
  // The real crash: a connection's paramValues.reasoning ("xhigh" / "max")
  // flowed through the legacy models[]/providers[] bridge into validateSettings,
  // which previously pinned effort to a closed enum and threw on boot. effort is
  // now a free-form string (catalog-driven); validateSettings must accept any
  // non-empty level on BOTH the provider- and model-level reasoning fields.

  it("accepts a known effort on a provider's reasoning", () => {
    expect(() =>
      validateSettings({
        providers: [
          { key: "oai", kind: "openai", baseUrl: "https://api.openai.com/v1", reasoning: { mode: "effort", effort: "high" } },
        ],
      }),
    ).not.toThrow();
  });

  it("accepts an UNKNOWN effort on a provider's reasoning (the boot-crash level)", () => {
    // "xhigh" / "max" are levels models gained over time and are not in
    // REASONING_EFFORTS — these must NOT throw.
    for (const effort of ["xhigh", "max"]) {
      expect(() =>
        validateSettings({
          providers: [
            { key: "oai", kind: "openai", baseUrl: "https://api.openai.com/v1", reasoning: { mode: "effort", effort } },
          ],
        }),
      ).not.toThrow();
    }
  });

  it("accepts an unknown effort on a per-model reasoning override too", () => {
    const parsed = validateSettings({
      models: [
        { key: "m1", model: "gpt-5.5", reasoning: { mode: "effort", effort: "max" } },
      ],
    });
    expect(parsed.models[0].reasoning).toEqual({ mode: "effort", effort: "max" });
  });

  it("still rejects a malformed reasoning SHAPE (empty effort / wrong mode)", () => {
    // The schema validates shape, not value: empty effort and bogus mode must fail.
    expect(() =>
      validateSettings({
        providers: [{ key: "oai", kind: "openai", baseUrl: "x", reasoning: { mode: "effort", effort: "" } }],
      }),
    ).toThrow();
    expect(() =>
      validateSettings({
        providers: [{ key: "oai", kind: "openai", baseUrl: "x", reasoning: { mode: "bogus" } }],
      }),
    ).toThrow();
  });
});

describe("mcpServerOverrides (plugin MCP env/credential supplement)", () => {
  it("accepts the env/credential supplement fields", () => {
    const parsed = SettingsSchema.parse({
      mcpServerOverrides: {
        "gh:server": { envVars: ["GITHUB_TOKEN"], env: { A: "b" }, credentialRef: "c" },
      },
    });
    expect(parsed.mcpServerOverrides["gh:server"].envVars).toEqual(["GITHUB_TOKEN"]);
    expect(parsed.mcpServerOverrides["gh:server"].credentialRef).toBe("c");
  });

  it("REJECTS command/args/url/transport — those are owned by the plugin manifest", () => {
    expect(() =>
      SettingsSchema.parse({ mcpServerOverrides: { "gh:server": { command: "evil" } } }),
    ).toThrow();
    expect(() =>
      SettingsSchema.parse({ mcpServerOverrides: { "gh:server": { url: "http://evil" } } }),
    ).toThrow();
  });

  it("defaults to an empty record when absent", () => {
    expect(SettingsSchema.parse({}).mcpServerOverrides).toEqual({});
  });
});
