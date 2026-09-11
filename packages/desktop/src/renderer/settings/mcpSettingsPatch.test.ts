import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSettings, writeSettings } from "../../main/settings-service";
import { buildMcpSettingsPatch, type McpSettingsPatchInput } from "./mcpSettingsPatch";

const projects: string[] = [];
afterEach(async () => {
  await Promise.all(projects.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function saveThroughJson(previous: McpSettingsPatchInput, next: McpSettingsPatchInput) {
  const project = await mkdtemp(join(tmpdir(), "codeshell-mcp-settings-patch-"));
  projects.push(project);
  await writeSettings("project", { mcpServers: { fixture: previous } }, project);
  const patch = buildMcpSettingsPatch(next, previous);
  // Exercise the stricter Web transport too; deletion cannot depend on an
  // Electron structured-clone payload retaining undefined-valued properties.
  await writeSettings(
    "project",
    JSON.parse(JSON.stringify({ mcpServers: { fixture: patch } })),
    project,
  );
  const stored = await readSettings("project", project);
  return (stored?.mcpServers as Record<string, Record<string, unknown>>).fixture;
}

describe("MCP editor settings patches", () => {
  test("removes deleted environment and header keys through the real recursive settings writer", async () => {
    const previous = {
      transport: "stdio" as const,
      command: "fixture-tool",
      env: { KEEP: "x", DROP: "synthetic-secret" },
      headers: { Keep: "header", Drop: "synthetic-token" },
      envHeaders: { Keep: "KEPT_ENV", Drop: "REMOVED_ENV" },
    };
    const stored = await saveThroughJson(previous, {
      ...previous,
      env: { KEEP: "x" },
      headers: { Keep: "header" },
      envHeaders: { Keep: "KEPT_ENV" },
    });
    expect(stored.env).toEqual({ KEEP: "x" });
    expect(stored.headers).toEqual({ Keep: "header" });
    expect(stored.envHeaders).toEqual({ Keep: "KEPT_ENV" });
  });

  test("switches transport without retaining old command, arguments, or environment", async () => {
    const stored = await saveThroughJson(
      { transport: "stdio", command: "fixture-tool", args: ["old"], env: { TOKEN: "synthetic" } },
      { transport: "streamable-http", url: "https://fixture.invalid/mcp" },
    );
    expect(stored).toEqual({ transport: "streamable-http", url: "https://fixture.invalid/mcp" });
  });

  test("clears previous HTTP credentials and URL when switching to stdio", async () => {
    const stored = await saveThroughJson(
      {
        transport: "streamable-http",
        url: "https://fixture.invalid/mcp",
        credentialRef: "synthetic-credential",
        bearerTokenEnvVar: "SYNTHETIC_TOKEN",
        headers: { Authorization: "synthetic" },
        envHeaders: { Token: "SYNTHETIC_TOKEN" },
      },
      { transport: "stdio", command: "fixture-tool" },
    );
    expect(stored).toEqual({ transport: "stdio", command: "fixture-tool" });
  });

  test("preserves explicit disabled flags, empty arrays, and empty map values", async () => {
    const stored = await saveThroughJson(
      { command: "fixture-tool", enabled: true, env: { DROP: "old" }, allowedTools: ["old"] },
      {
        command: "fixture-tool",
        enabled: false,
        args: [],
        env: { EMPTY: "" },
        envVars: [],
        allowedTools: [],
        disabledTools: [],
      },
    );
    expect(stored).toEqual({
      command: "fixture-tool",
      enabled: false,
      args: [],
      env: { EMPTY: "" },
      envVars: [],
      allowedTools: [],
      disabledTools: [],
    });
  });

  test("restricts override patches to the requested supplemental fields", () => {
    const patch = buildMcpSettingsPatch(
      { command: "ignored", url: "https://ignored.invalid", enabled: false, env: { KEEP: "x" } },
      { command: "plugin-command", env: { KEEP: "x", DROP: "old" } },
      ["env", "credentialRef", "enabled"],
    );
    expect(patch).toEqual({ env: { DROP: null, KEEP: "x" }, credentialRef: null, enabled: false });
  });

  test("does not mutate or share mutable draft containers", () => {
    const previous = { env: { DROP: "old" } };
    const next = { env: { KEEP: "new" }, args: ["one"] };
    const patch = buildMcpSettingsPatch(next, previous);
    (patch.env as Record<string, unknown>).KEEP = "changed";
    (patch.args as string[]).push("two");
    expect(previous).toEqual({ env: { DROP: "old" } });
    expect(next).toEqual({ env: { KEEP: "new" }, args: ["one"] });
  });
});
