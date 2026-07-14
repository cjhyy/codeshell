import { describe, test, expect } from "bun:test";
import { CodexPluginManifest, PluginPanelsManifest, CSMeta, PluginInstallError } from "./types.js";

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
