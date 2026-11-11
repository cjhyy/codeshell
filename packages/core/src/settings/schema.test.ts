import { describe, it, test, expect } from "bun:test";
import { SettingsSchema } from "./schema.js";
import { isProtectedSettingKey } from "./manager.js";

describe("MCP startup policy", () => {
  test("preserves bounded per-server settings and plugin overrides", () => {
    const config = SettingsSchema.parse({
      mcpServers: { test: { command: "test", connectTimeoutMs: 90_000, connectRetries: 2 } },
      mcpServerOverrides: { "plugin:test": { connectTimeoutMs: 50_000, connectRetries: 0 } },
    });
    expect(config.mcpServers.test.connectTimeoutMs).toBe(90_000);
    expect(config.mcpServerOverrides["plugin:test"].connectRetries).toBe(0);
  });
  test("rejects unbounded, fractional and negative startup policies", () => {
    for (const policy of [
      { connectTimeoutMs: 0 },
      { connectTimeoutMs: 120_001 },
      { connectTimeoutMs: 1.5 },
      { connectRetries: -1 },
      { connectRetries: 3 },
      { connectRetries: 0.5 },
    ]) {
      expect(
        SettingsSchema.safeParse({ mcpServers: { test: { command: "test", ...policy } } }).success,
      ).toBe(false);
      expect(
        SettingsSchema.safeParse({ mcpServerOverrides: { "plugin:test": policy } }).success,
      ).toBe(false);
    }
  });
});

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

describe("Panel App settings", () => {
  test("pins contain only a bounded package identity and cannot be written through generic config", () => {
    const pin = { version: "1.0.0", packageDigest: "a".repeat(64) };
    expect(SettingsSchema.parse({ panelAppPins: { demo: pin } }).panelAppPins.demo).toEqual(pin);
    for (const pins of [
      null,
      { "../escape": pin },
      { demo: { ...pin, installPath: "/tmp/package" } },
      { demo: { ...pin, packageDigest: "latest" } },
    ])
      expect(SettingsSchema.safeParse({ panelAppPins: pins }).success).toBe(false);
    expect(isProtectedSettingKey("panelAppPins")).toBe(true);
    expect(isProtectedSettingKey("panelAppPins.demo.packageDigest")).toBe(true);
  });
  it("defaults to an empty global denylist and no project bindings", () => {
    const parsed = SettingsSchema.parse({});
    expect(parsed.disabledPanelApps).toEqual([]);
    expect(parsed.panelAppBindings).toEqual([]);
    expect(parsed.panelAppOverrides).toEqual({});
  });

  it("keeps explicit Panel App bindings outside agent capability overrides", () => {
    const parsed = SettingsSchema.parse({
      disabledPanelApps: ["design-studio"],
      panelAppBindings: ["design-studio", "quant-lab"],
      panelAppOverrides: { "design-studio": "on", "quant-lab": "off" },
    });
    expect(parsed.disabledPanelApps).toEqual(["design-studio"]);
    expect(parsed.panelAppBindings).toEqual(["design-studio", "quant-lab"]);
    expect(parsed.panelAppOverrides).toEqual({
      "design-studio": "on",
      "quant-lab": "off",
    });
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
        pet: { showExternalCodexSessions: "on" },
      },
    });
    expect(parsed.capabilityOverrides?.skills?.helper).toBe("on");
    expect(parsed.capabilityOverrides?.mcp?.playwright).toBe("off");
    expect(parsed.capabilityOverrides?.pet?.showExternalCodexSessions).toBe("on");
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

describe("pet settings (Mimi global-view external-session visibility)", () => {
  it("pet external-session toggles default to false and validate booleans", () => {
    const parsed = SettingsSchema.parse({});
    expect(parsed.pet).toEqual({
      showExternalCodexSessions: false,
      showExternalClaudeSessions: false,
      memoryAutoExtract: true,
    });
    expect(
      SettingsSchema.parse({ pet: { showExternalCodexSessions: true } }).pet
        ?.showExternalCodexSessions,
    ).toBe(true);
  });

  it("accepts bounded Mimi-only personalization independently of agent settings", () => {
    const parsed = SettingsSchema.parse({
      pet: {
        personalization: {
          responseLanguage: "简体中文",
          userProfile: "叫我 Maki",
          communicationStyle: "亲切、简洁、直接",
          customInstructions: "工作汇报先说结论",
        },
      },
      agent: { responseLanguage: "English" },
    });

    expect(parsed.pet?.personalization).toEqual({
      responseLanguage: "简体中文",
      userProfile: "叫我 Maki",
      communicationStyle: "亲切、简洁、直接",
      customInstructions: "工作汇报先说结论",
    });
    expect(parsed.agent.responseLanguage).toBe("English");
  });

  it("keeps bounded notification preferences", () => {
    const notifications = {
      quietHours: { start: "22:30", end: "07:00", enabled: false },
      maxPerHour: 60,
      maxP0PerHour: 120,
      mergeWindowSec: 0,
      presenceIdleSec: 1_800,
      delegatedFromDesktop: "desktop",
    };
    expect(SettingsSchema.parse({ pet: { notifications } }).pet?.notifications).toEqual(
      notifications,
    );
    // null is the writer's "delete": it means the host default, not "off".
    expect(
      SettingsSchema.parse({ pet: { notifications: { quietHours: null } } }).pet?.notifications
        ?.quietHours,
    ).toBeUndefined();
    // Absent stays absent: defaults belong to the host, not the file.
    expect(SettingsSchema.parse({}).pet?.notifications).toBeUndefined();
  });

  it("drops out-of-range notification fields without rejecting the settings file", () => {
    const parsed = SettingsSchema.parse({
      agent: { responseLanguage: "English" },
      pet: {
        memoryAutoExtract: false,
        notifications: {
          quietHours: { start: "24:00", end: "08:00" },
          maxPerHour: 0,
          maxP0PerHour: 121,
          mergeWindowSec: 3_601,
          presenceIdleSec: 29,
          delegatedFromDesktop: "im",
        },
      },
    });
    expect(parsed.pet?.memoryAutoExtract).toBe(false);
    expect(parsed.agent.responseLanguage).toBe("English");
    expect(Object.values(parsed.pet?.notifications ?? {}).every((v) => v === undefined)).toBe(true);
    expect(
      SettingsSchema.parse({ pet: { notifications: { maxPerHour: 1.5 } } }).pet?.notifications
        ?.maxPerHour,
    ).toBeUndefined();
    expect(
      SettingsSchema.parse({ pet: { notifications: "loud" } }).pet?.notifications,
    ).toBeUndefined();
  });

  it("keeps the briefs, heartbeat and digest slots, dropping bad parts one by one", () => {
    const proactive = {
      briefs: { morning: { enabled: true, time: "08:45" }, evening: { enabled: false } },
      heartbeat: { enabled: true, activeHours: { start: "10:00", end: "21:30" } },
      digestSlots: ["12:00", "18:00"],
    };
    expect(SettingsSchema.parse({ pet: { notifications: proactive } }).pet?.notifications).toEqual(
      proactive,
    );
    const parsed = SettingsSchema.parse({
      pet: {
        notifications: {
          maxPerHour: 5,
          briefs: { morning: { enabled: "yes", time: "9:00" }, evening: { time: "18:15" } },
          heartbeat: { enabled: true, activeHours: { start: "10:00", end: "26:00" } },
          digestSlots: ["12:00", "1200"],
        },
      },
    }).pet?.notifications;
    expect(parsed?.maxPerHour).toBe(5);
    // Each malformed leaf falls back on its own; the rest of the object is kept.
    expect(parsed?.briefs).toEqual({ morning: {}, evening: { time: "18:15" } });
    expect(parsed?.heartbeat).toEqual({ enabled: true });
    // A slot list is one value: any malformed slot (or more than six) drops the list.
    expect(parsed?.digestSlots).toBeUndefined();
    expect(
      SettingsSchema.parse({
        pet: {
          notifications: {
            digestSlots: ["01:00", "02:00", "03:00", "04:00", "05:00", "06:00", "07:00"],
          },
        },
      }).pet?.notifications?.digestSlots,
    ).toBeUndefined();
  });
});
