import { describe, test, expect } from "bun:test";
import { CodexPluginManifest, CSMeta, PluginInstallError } from "./types.js";

describe("CodexPluginManifest", () => {
  test("accepts minimal manifest with string mcpServers ref", () => {
    const m = CodexPluginManifest.parse({ name: "p", version: "1.0.0", mcpServers: "./.mcp.json" });
    expect(m.name).toBe("p");
    expect(m.mcpServers).toBe("./.mcp.json");
  });
  test("accepts inline mcpServers object", () => {
    const m = CodexPluginManifest.parse({ name: "p", version: "1", mcpServers: { foo: { command: "x" } } });
    expect(typeof m.mcpServers).toBe("object");
  });
  test("preserves unknown fields via passthrough", () => {
    const m = CodexPluginManifest.parse({ name: "p", version: "1", futureField: 42 }) as Record<string, unknown>;
    expect(m.futureField).toBe(42);
  });
  test("rejects missing name", () => {
    expect(() => CodexPluginManifest.parse({ version: "1" })).toThrow();
  });
});

describe("CSMeta", () => {
  test("round-trips a codex meta", () => {
    const meta = CSMeta.parse({
      name: "p", format: "codex", version: "1.2.3",
      source: "/abs/src", installedAt: "2026-05-29T10:00:00Z",
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
