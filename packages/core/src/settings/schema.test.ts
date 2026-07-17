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
    expect(() =>
      SettingsSchema.parse({ capabilityOverrides: { skills: { a: "maybe" } } }),
    ).toThrow();
  });
});

describe("worktree settings", () => {
  it("defaults branchPrefix to the historical CodeShell prefix", () => {
    const parsed = SettingsSchema.parse({});
    expect(parsed.worktree.branchPrefix).toBe("worktree/");
  });

  it("normalizes a branchPrefix without a trailing slash", () => {
    const parsed = SettingsSchema.parse({ worktree: { branchPrefix: "agent" } });
    expect(parsed.worktree.branchPrefix).toBe("agent/");
  });

  it("rejects unsafe branch prefixes", () => {
    expect(() => SettingsSchema.parse({ worktree: { branchPrefix: "" } })).toThrow();
    expect(() => SettingsSchema.parse({ worktree: { branchPrefix: "../bad" } })).toThrow();
    expect(() => SettingsSchema.parse({ worktree: { branchPrefix: "bad prefix/" } })).toThrow();
  });
});

describe('mcpServers name resilience (regression: settings died on {"23":{no name}})', () => {
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
        figma: {
          transport: "streamable-http",
          url: "https://x/mcp",
          credentialRef: "my-figma-token",
        },
      },
    });
    expect(parsed.mcpServers.figma.credentialRef).toBe("my-figma-token");
  });
});

describe("mcpServerOverrides (plugin MCP user policy and credentials)", () => {
  it("accepts server/tool policy and env/credential supplement fields", () => {
    const parsed = SettingsSchema.parse({
      mcpServerOverrides: {
        "gh:server": {
          enabled: false,
          allowedTools: ["search", "read"],
          disabledTools: ["delete"],
          envVars: ["GITHUB_TOKEN"],
          env: { A: "b" },
          credentialRef: "c",
        },
      },
    });
    expect(parsed.mcpServerOverrides["gh:server"].enabled).toBe(false);
    expect(parsed.mcpServerOverrides["gh:server"].allowedTools).toEqual(["search", "read"]);
    expect(parsed.mcpServerOverrides["gh:server"].disabledTools).toEqual(["delete"]);
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

  it("bounds MCP tool policy names and list length", () => {
    expect(() =>
      SettingsSchema.parse({
        mcpServerOverrides: { "gh:server": { allowedTools: [""] } },
      }),
    ).toThrow();
    expect(() =>
      SettingsSchema.parse({
        mcpServerOverrides: {
          "gh:server": {
            disabledTools: Array.from({ length: 257 }, (_, index) => `tool-${index}`),
          },
        },
      }),
    ).toThrow();
  });
});
