import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createBunTestEnvironment } from "../../../../../scripts/bun-test-completion.mjs";

describe("data source destination navigation", () => {
  test("keeps global navigation and project selection in their own scopes", () => {
    const privateDirectory = mkdtempSync(join(tmpdir(), "codeshell-source-navigation-ui-"));
    const result = Bun.spawnSync({
      cmd: [
        process.execPath,
        fileURLToPath(new URL("./DataSourcesModule.interaction.fixture.tsx", import.meta.url)),
      ],
      env: createBunTestEnvironment(process.env, privateDirectory),
      stdout: "pipe",
      stderr: "pipe",
      timeout: 10_000,
      killSignal: "SIGKILL",
      maxBuffer: 1024 * 1024,
    });
    expect({ exitCode: result.exitCode, stderr: result.stderr.toString() }).toEqual({
      exitCode: 0,
      stderr: "",
    });
    expect(JSON.parse(result.stdout.toString())).toEqual({ passed: true });
  });
});
