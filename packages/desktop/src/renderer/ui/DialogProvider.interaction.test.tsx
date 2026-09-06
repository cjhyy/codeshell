import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

describe("DialogProvider real Radix interactions", () => {
  test.each([
    "escape-confirm",
    "escape-alert",
    "escape-prompt",
    "prompt-ime",
    "prompt-draft",
    "stale-close",
  ])("%s", (scenario) => {
    const result = Bun.spawnSync({
      cmd: [
        process.execPath,
        fileURLToPath(new URL("./DialogProvider.fixture.tsx", import.meta.url)),
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
