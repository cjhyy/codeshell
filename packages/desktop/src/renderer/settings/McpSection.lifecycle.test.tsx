import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

describe("MCP settings target and failure lifecycle", () => {
  test.each([
    "credentials-error",
    "target-switch",
    "stale-confirmation",
    "stale-load",
    "save-error",
    "save-lock",
    "stale-save",
    "patch-only-edited",
    "rename",
    "disabled-save",
    "toggle-only-enabled",
    "editor-switch",
    "probe-error",
    "args-roundtrip",
    "args-other-field",
    "args-imported",
    "args-edit",
    "args-clear",
    "rename-options-project",
    "rename-options-user",
    "rename-edited-cleared",
    "rename-same-name",
    "rename-plugin-override",
  ])("%s", (scenario) => {
    const result = Bun.spawnSync({
      cmd: [
        process.execPath,
        fileURLToPath(new URL("./McpSection.lifecycle.fixture.tsx", import.meta.url)),
        scenario,
      ],
      stdout: "pipe",
      stderr: "pipe",
    });
    expect({ exitCode: result.exitCode, stderr: result.stderr.toString() }).toEqual({
      exitCode: 0,
      stderr: "",
    });
    if (scenario.startsWith("rename-")) {
      expect(result.stdout.toString()).toContain(
        'OWNED_MCP_RENAME_GUARD {"probes":8,"actualAttempts":0,"mergeSourceSHA256":"025fea64b52ad94d36bcb76759dfe586a363eb8667cf7bbb7118b8caeae21511"}',
      );
    }
    if (scenario.startsWith("args-")) {
      expect(result.stdout.toString()).toContain(
        'OWNED_MCP_ARGS_GUARD {"probes":8,"actualAttempts":0}',
      );
    }
  });
});
