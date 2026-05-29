import { describe, test, expect } from "bun:test";
import { convertCodexAgentToml } from "./convertAgents.js";

describe("convertCodexAgentToml", () => {
  test("maps name/description/model and developer_instructions→body", () => {
    const toml = [
      'name = "researcher"',
      'description = "Read-only research"',
      'model = "flash"',
      'developer_instructions = "Investigate. Never edit."',
    ].join("\n");
    const md = convertCodexAgentToml(toml, "researcher.toml", "myplugin");
    expect(md).toContain("name: researcher");
    expect(md).toContain("description: Read-only research");
    expect(md).toContain("model: flash");
    expect(md).toContain("Investigate. Never edit.");
  });

  test("preserves unmappable fields with codex_ prefix", () => {
    const toml = [
      'name = "a"', 'description = "d"',
      'model_reasoning_effort = "high"',
      'sandbox_mode = "read-only"',
    ].join("\n");
    const md = convertCodexAgentToml(toml, "a.toml", "myplugin");
    expect(md).toContain("codex_model_reasoning_effort: high");
    expect(md).toContain("codex_sandbox_mode: read-only");
    expect(md).not.toContain("thinking:");
  });

  test("rewrites mcp_servers values to <plugin>:<server> under codex_mcp_servers", () => {
    const toml = ['name = "a"', 'description = "d"', 'mcp_servers = ["fs", "gh"]'].join("\n");
    const md = convertCodexAgentToml(toml, "a.toml", "myplugin");
    expect(md).toContain("codex_mcp_servers:");
    expect(md).toContain("myplugin:fs");
    expect(md).toContain("myplugin:gh");
  });

  test("double-prefixes a field that already starts with codex_", () => {
    const toml = ['name = "a"', 'description = "d"', 'codex_foo = "x"'].join("\n");
    const md = convertCodexAgentToml(toml, "a.toml", "myplugin");
    expect(md).toContain("codex_codex_foo: x");
  });

  test("throws when name is missing", () => {
    expect(() => convertCodexAgentToml('description = "d"', "bad.toml", "p")).toThrow(/name/);
  });

  test("throws when description is missing", () => {
    expect(() => convertCodexAgentToml('name = "a"', "bad.toml", "p")).toThrow(/description/);
  });
});
