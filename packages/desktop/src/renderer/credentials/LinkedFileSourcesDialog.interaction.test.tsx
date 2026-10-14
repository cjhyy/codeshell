import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createBunTestEnvironment } from "../../../../../scripts/bun-test-completion.mjs";

describe("linked file source selection interactions", () => {
  test.each([
    "github-explicit",
    "github-unrestricted",
    "github-unseen-repository",
    "repository-change-clears-files",
    "too-many-files",
    "normal-priority",
    "figma-authorized",
    "figma-explicit",
    "restricted-figma",
    "connection-change-clears-selection",
    "project-change-clears-selection",
    "stale-project-snapshot",
    "snapshot-failure-retry",
    "add-failure-retry",
    "add-lock",
    "add-unmount",
    "add-project-disappears",
    "cancel-without-add",
    "empty-connections",
  ])("%s", (scenario) => {
    const privateDirectory = mkdtempSync(join(tmpdir(), "codeshell-linked-source-ui-"));
    const result = Bun.spawnSync({
      cmd: [
        process.execPath,
        fileURLToPath(
          new URL("./LinkedFileSourcesDialog.interaction.fixture.tsx", import.meta.url),
        ),
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
