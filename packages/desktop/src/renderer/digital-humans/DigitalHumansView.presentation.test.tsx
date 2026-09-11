import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

describe("digital-human library presentation interactions", () => {
  test.each([
    "search-zh",
    "search-en",
    "empty-market-zh",
    "empty-market-en",
    "repo-input",
    "save-target-switch",
    "settings-save-target-switch",
    "settings-stale-list",
    "settings-failed-target-skills",
    "settings-repo-input",
    "start-target-switch",
    "default-target-switch",
  ])("%s", (scenario) => {
    const result = Bun.spawnSync({
      cmd: [
        process.execPath,
        fileURLToPath(new URL("./DigitalHumansView.presentation.fixture.tsx", import.meta.url)),
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
