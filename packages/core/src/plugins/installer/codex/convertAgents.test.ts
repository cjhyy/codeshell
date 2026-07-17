import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { convertCodexAgentToml, convertCodexAgentsDirectory } from "./convertAgents.js";

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
      'name = "a"',
      'description = "d"',
      'model_reasoning_effort = "high"',
      'sandbox_mode = "read-only"',
    ].join("\n");
    const md = convertCodexAgentToml(toml, "a.toml", "myplugin");
    expect(md).toContain("codex_model_reasoning_effort: high");
    expect(md).toContain("codex_sandbox_mode: read-only");
    expect(md).not.toContain("thinking:");
  });

  test("maps mcp_servers to the enforced namespaced MCP allowlist", () => {
    const toml = ['name = "a"', 'description = "d"', 'mcp_servers = ["fs", "gh"]'].join("\n");
    const md = convertCodexAgentToml(toml, "a.toml", "myplugin");
    expect(md).toContain("mcp:");
    expect(md).toContain("myplugin:fs");
    expect(md).toContain("myplugin:gh");
    expect(md).not.toContain("codex_mcp_servers");
  });

  test("rejects malformed MCP allowlists instead of silently broadening access", () => {
    expect(() =>
      convertCodexAgentToml(
        ['name = "a"', 'description = "d"', 'mcp_servers = ["good", "bad name"]'].join("\n"),
        "a.toml",
        "myplugin",
      ),
    ).toThrow(/mcp_servers/);
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

describe("convertCodexAgentsDirectory", () => {
  let src: string;
  let dest: string;

  beforeEach(() => {
    src = mkdtempSync(join(tmpdir(), "cs-agent-src-"));
    dest = mkdtempSync(join(tmpdir(), "cs-agent-dest-"));
  });

  afterEach(() => {
    rmSync(src, { recursive: true, force: true });
    rmSync(dest, { recursive: true, force: true });
  });

  test("converts nested agent TOML files", async () => {
    mkdirSync(join(src, "agents", "review"), { recursive: true });
    writeFileSync(
      join(src, "agents", "review", "security.toml"),
      ['name = "security"', 'description = "Review security"'].join("\n"),
    );
    await convertCodexAgentsDirectory(src, dest, "safe");
    expect(existsSync(join(dest, "agents", "review", "security.md"))).toBe(true);
  });

  test("rejects an agent file symlink that escapes the plugin root", async () => {
    if (process.platform === "win32") return;
    const outside = mkdtempSync(join(tmpdir(), "cs-agent-outside-"));
    try {
      mkdirSync(join(src, "agents"), { recursive: true });
      writeFileSync(
        join(outside, "private.toml"),
        ['name = "private"', 'description = "must not be imported"'].join("\n"),
      );
      symlinkSync(join(outside, "private.toml"), join(src, "agents", "leak.toml"));
      await expect(convertCodexAgentsDirectory(src, dest, "unsafe")).rejects.toThrow(
        "agent source escapes plugin dir",
      );
      expect(existsSync(join(dest, "agents", "leak.md"))).toBe(false);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("rejects an agents directory symlink that escapes the plugin root", async () => {
    if (process.platform === "win32") return;
    const outside = mkdtempSync(join(tmpdir(), "cs-agent-dir-outside-"));
    try {
      writeFileSync(
        join(outside, "leak.toml"),
        ['name = "private"', 'description = "must not be imported"'].join("\n"),
      );
      symlinkSync(outside, join(src, "agents"));
      await expect(convertCodexAgentsDirectory(src, dest, "unsafe")).rejects.toThrow(
        "agent source escapes plugin dir",
      );
      expect(existsSync(join(dest, "agents"))).toBe(false);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
