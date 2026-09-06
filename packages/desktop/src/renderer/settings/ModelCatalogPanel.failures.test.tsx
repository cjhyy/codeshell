import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

describe("model catalog read and mutation recovery", () => {
  test.each([
    "load-retry",
    "origins-retry",
    "refresh-race",
    "save-retry",
    "save-external-focus",
    "cancel-focus",
    "cancel-refresh",
    "delete-retry",
    "reset-retry",
    "unmount",
  ])("%s", (scenario) => {
    // Other renderer suites replace Dialog modules globally. Keep this real
    // provider/portal mount independent of those module mocks.
    const result = Bun.spawnSync({
      cmd: [
        process.execPath,
        fileURLToPath(new URL("./ModelCatalogPanel.failures.fixture.tsx", import.meta.url)),
        scenario,
      ],
      stdout: "pipe",
      stderr: "pipe",
    });
    expect({ exitCode: result.exitCode, stderr: result.stderr.toString() }).toEqual({
      exitCode: 0,
      stderr: "",
    });
  });
});
