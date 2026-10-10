import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createBunTestEnvironment } from "../../../../../scripts/bun-test-completion.mjs";

describe("reusable collection interactions", () => {
  test.each([
    "create-and-edit",
    "cancel-create",
    "picker-cancel-lock",
    "folder-current-list",
    "url-refresh-failure",
    "remove-cancel",
    "cancel-confirmation",
    "delete-impact",
    "delete-inspection-failure",
    "stale-collection-load",
    "collection-load-failure",
    "project-all-current",
    "project-subset",
    "profile-excluded-binding",
    "stale-project-load",
    "stale-scope-load",
    "project-save-lock",
    "project-compatibility",
  ])("%s", (scenario) => {
    const privateDirectory = mkdtempSync(join(tmpdir(), "codeshell-collection-ui-"));
    const result = Bun.spawnSync({
      cmd: [
        process.execPath,
        fileURLToPath(new URL("./SourceCollections.interaction.fixture.tsx", import.meta.url)),
        scenario,
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
    expect(JSON.parse(result.stdout.toString())).toMatchObject({
      scenario,
      passed: true,
      unexpectedRequests: 0,
    });
  });
});
