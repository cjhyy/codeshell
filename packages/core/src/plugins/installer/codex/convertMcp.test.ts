import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveCodexMcpServers, normalizeCodexMcpFields } from "./convertMcp.js";

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

  test("normalizes Codex snake_case secret fields to camelCase (inline)", () => {
    // A real Codex .mcp.json writes snake_case (bearer_token_env_var etc).
    // The runtime manager reads camelCase, so resolve must re-key them or the
    // env-secret references silently never apply. See normalizeCodexMcpFields.
    const servers = resolveCodexMcpServers(dir, {
      figma: {
        url: "https://mcp.figma.com",
        bearer_token_env_var: "FIGMA_TOKEN",
        env_http_headers: { "X-Org": "ORG_ID" },
      },
      gh: { command: "g", env_vars: ["GITHUB_TOKEN"] },
    });
    expect(servers).toEqual({
      figma: {
        url: "https://mcp.figma.com",
        bearerTokenEnvVar: "FIGMA_TOKEN",
        envHeaders: { "X-Org": "ORG_ID" },
      },
      gh: { command: "g", envVars: ["GITHUB_TOKEN"] },
    });
  });

  test("normalizes snake_case fields read from a referenced .mcp.json", () => {
    writeFileSync(
      join(dir, ".mcp.json"),
      JSON.stringify({ mcpServers: { fig: { url: "u", bearer_token_env_var: "T" } } }),
    );
    const servers = resolveCodexMcpServers(dir, "./.mcp.json");
    expect(servers).toEqual({ fig: { url: "u", bearerTokenEnvVar: "T" } });
  });

  test("leaves already-camelCase fields untouched and keeps unknown fields", () => {
    const servers = resolveCodexMcpServers(dir, {
      s: { command: "c", bearerTokenEnvVar: "T", env: { A: "1" }, somethingElse: true },
    });
    expect(servers).toEqual({
      s: { command: "c", bearerTokenEnvVar: "T", env: { A: "1" }, somethingElse: true },
    });
  });
});

describe("normalizeCodexMcpFields", () => {
  test("maps the three snake_case secret fields to camelCase", () => {
    expect(
      normalizeCodexMcpFields({
        bearer_token_env_var: "T",
        env_http_headers: { H: "E" },
        env_vars: ["A"],
        command: "c",
      }),
    ).toEqual({
      bearerTokenEnvVar: "T",
      envHeaders: { H: "E" },
      envVars: ["A"],
      command: "c",
    });
  });

  test("an existing camelCase value wins over a snake_case duplicate", () => {
    // Defensive: if both forms are present, don't clobber the canonical one.
    expect(
      normalizeCodexMcpFields({ bearerTokenEnvVar: "canonical", bearer_token_env_var: "legacy" }),
    ).toEqual({ bearerTokenEnvVar: "canonical" });
  });

  test("non-object input is returned unchanged", () => {
    expect(normalizeCodexMcpFields("nope" as unknown as Record<string, unknown>)).toBe("nope");
  });
});
