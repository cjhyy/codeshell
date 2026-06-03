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

  test("rejects a ../ traversal ref that escapes the plugin dir", () => {
    // A malicious manifest pointing outside the (possibly remote-cloned)
    // plugin dir must be refused before any filesystem read.
    expect(() => resolveCodexMcpServers(dir, "../../../../etc/hosts")).toThrow(/escapes plugin dir/);
  });

  test("rejects an absolute-path ref", () => {
    expect(() => resolveCodexMcpServers(dir, "/etc/hosts")).toThrow(/escapes plugin dir/);
  });

  test("allows a nested relative ref inside the plugin dir", () => {
    writeFileSync(join(dir, "nested.json"), JSON.stringify({ gh: { command: "g" } }));
    // ./a/../nested.json normalizes back inside the dir — must still resolve.
    const servers = resolveCodexMcpServers(dir, "./x/../nested.json");
    expect(servers).toEqual({ gh: { command: "g" } });
  });
});
