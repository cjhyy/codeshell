import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveCodexMcpServers } from "./convertMcp.js";

describe("resolveCodexMcpServers", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "cs-mcp-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  test("returns inline object as-is", () => {
    const servers = resolveCodexMcpServers(dir, { foo: { command: "x" } });
    expect(servers).toEqual({ foo: { command: "x" } });
  });

  test("reads a referenced .mcp.json (mcpServers key)", () => {
    writeFileSync(join(dir, ".mcp.json"), JSON.stringify({ mcpServers: { gh: { command: "g" } } }));
    const servers = resolveCodexMcpServers(dir, "./.mcp.json");
    expect(servers).toEqual({ gh: { command: "g" } });
  });

  test("reads a referenced .mcp.json that IS the map (no mcpServers wrapper)", () => {
    writeFileSync(join(dir, "m.json"), JSON.stringify({ gh: { command: "g" } }));
    const servers = resolveCodexMcpServers(dir, "m.json");
    expect(servers).toEqual({ gh: { command: "g" } });
  });

  test("returns empty when undefined", () => {
    expect(resolveCodexMcpServers(dir, undefined)).toEqual({});
  });

  test("throws on malformed referenced json", () => {
    writeFileSync(join(dir, "bad.json"), "{ not json");
    expect(() => resolveCodexMcpServers(dir, "bad.json")).toThrow();
  });
});
