import { describe, test, expect } from "bun:test";
import {
  CodexPluginManifest,
  PluginAutomationsManifest,
  PluginInterfaceMetadata,
  PluginPanelsManifest,
  CSMeta,
  PluginInstallError,
} from "./types.js";

describe("CodexPluginManifest", () => {
  test("accepts minimal manifest with string mcpServers ref", () => {
    const m = CodexPluginManifest.parse({ name: "p", version: "1.0.0", mcpServers: "./.mcp.json" });
    expect(m.name).toBe("p");
    expect(m.mcpServers).toBe("./.mcp.json");
  });
  test("accepts inline mcpServers object", () => {
    const m = CodexPluginManifest.parse({
      name: "p",
      version: "1",
      mcpServers: { foo: { command: "x" } },
    });
    expect(typeof m.mcpServers).toBe("object");
  });
  test("preserves unknown fields via passthrough", () => {
    const m = CodexPluginManifest.parse({ name: "p", version: "1", futureField: 42 }) as Record<
      string,
      unknown
    >;
    expect(m.futureField).toBe(42);
  });
  test("rejects missing name", () => {
    expect(() => CodexPluginManifest.parse({ version: "1" })).toThrow();
  });
});

describe("PluginPanelsManifest", () => {
  test("normalizes safe v1 entries with zero permissions by default", () => {
    const panels = PluginPanelsManifest.parse({
      version: 1,
      entries: [
        {
          id: "dashboard",
          title: { default: "Dashboard", "zh-CN": "仪表盘" },
          entry: "panels/dashboard/index.html",
        },
      ],
    });
    expect(panels.entries[0]).toMatchObject({
      icon: "panel",
      placement: "right-dock",
      singleton: true,
      permissions: [],
    });
  });

  test.each([
    "../index.html",
    "/index.html",
    "panels\\index.html",
    "panels/../index.html",
    "panels/index.html?x=1",
    "panels/index.js",
  ])("rejects unsafe panel entry %s", (entry) => {
    expect(() =>
      PluginPanelsManifest.parse({
        version: 1,
        entries: [{ id: "dashboard", title: { default: "Dashboard" }, entry }],
      }),
    ).toThrow();
  });

  test("rejects duplicate ids and unknown permissions", () => {
    expect(() =>
      PluginPanelsManifest.parse({
        version: 1,
        entries: [
          { id: "same", title: { default: "One" }, entry: "panels/one.html" },
          { id: "same", title: { default: "Two" }, entry: "panels/two.html" },
        ],
      }),
    ).toThrow(/duplicate panel id/);
    expect(() =>
      PluginPanelsManifest.parse({
        version: 1,
        entries: [
          {
            id: "panel",
            title: { default: "Panel" },
            entry: "panels/index.html",
            permissions: ["shell.exec"],
          },
        ],
      }),
    ).toThrow();
  });

  test("requires session context for the submit-prompt bridge", () => {
    expect(() =>
      PluginPanelsManifest.parse({
        version: 1,
        entries: [
          {
            id: "agent-panel",
            title: { default: "Agent" },
            entry: "panels/agent/index.html",
            permissions: ["agent.submitPrompt"],
          },
        ],
      }),
    ).toThrow(/requires context.session/);
  });

  test("accepts allowlisted lucide icon names and keeps the panel default", () => {
    const panels = PluginPanelsManifest.parse({
      version: 1,
      entries: [
        { id: "a", title: { default: "A" }, entry: "panels/a.html", icon: "bar-chart-3" },
        { id: "b", title: { default: "B" }, entry: "panels/b.html" },
      ],
    });
    expect(panels.entries[0].icon).toBe("bar-chart-3");
    expect(panels.entries[1].icon).toBe("panel");
  });

  test("rejects icon names outside the allowlist", () => {
    expect(() =>
      PluginPanelsManifest.parse({
        version: 1,
        entries: [{ id: "a", title: { default: "A" }, entry: "panels/a.html", icon: "grid-3x3" }],
      }),
    ).toThrow();
  });
});

describe("PluginAutomationsManifest", () => {
  test("normalizes safe templates to read-only current-workspace defaults", () => {
    const automations = PluginAutomationsManifest.parse({
      version: 1,
      templates: [
        {
          id: "weekday-review",
          title: { default: "Weekday review", "zh-CN": "工作日检查" },
          schedule: "0 9 * * 1-5",
          prompt: "Inspect pending work and report risks.",
        },
      ],
    });
    expect(automations.templates[0]).toMatchObject({
      permissionLevel: "read-only",
      workspace: "current",
    });
  });

  test("rejects duplicate ids, unknown execution fields, and oversized prompts", () => {
    expect(() =>
      PluginAutomationsManifest.parse({
        version: 1,
        templates: [
          { id: "same", title: { default: "One" }, schedule: "1h", prompt: "one" },
          { id: "same", title: { default: "Two" }, schedule: "2h", prompt: "two" },
        ],
      }),
    ).toThrow(/duplicate automation template id/);
    expect(
      PluginAutomationsManifest.safeParse({
        version: 1,
        templates: [
          {
            id: "unsafe",
            title: { default: "Unsafe" },
            schedule: "1h",
            prompt: "run",
            cwd: "/tmp/plugin-selected",
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      PluginAutomationsManifest.safeParse({
        version: 1,
        templates: [
          {
            id: "too-large",
            title: { default: "Too large" },
            schedule: "1h",
            prompt: "x".repeat(32_769),
          },
        ],
      }).success,
    ).toBe(false);
  });
});

describe("PluginInterfaceMetadata", () => {
  test("accepts at most three default prompts of at most 128 characters", () => {
    expect(
      PluginInterfaceMetadata.parse({
        defaultPrompt: ["a".repeat(128), "second", "third"],
      }).defaultPrompt,
    ).toHaveLength(3);
    expect(
      PluginInterfaceMetadata.safeParse({
        defaultPrompt: ["one", "two", "three", "four"],
      }).success,
    ).toBe(false);
    expect(
      PluginInterfaceMetadata.safeParse({
        defaultPrompt: ["a".repeat(129)],
      }).success,
    ).toBe(false);
  });
});

describe("CSMeta", () => {
  test("round-trips a codex meta", () => {
    const meta = CSMeta.parse({
      name: "p",
      format: "codex",
      version: "1.2.3",
      source: "/abs/src",
      installedAt: "2026-05-29T10:00:00Z",
    });
    expect(meta.format).toBe("codex");
  });
});

describe("PluginInstallError", () => {
  test("carries a message", () => {
    const e = new PluginInstallError("boom");
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe("PluginInstallError");
    expect(e.message).toBe("boom");
  });
});
