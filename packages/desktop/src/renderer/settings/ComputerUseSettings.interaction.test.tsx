import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

// Each fixture has its own DOM and fake bridge; it never requests OS access.
for (const scenario of [
  "disabled",
  "request-accessibility",
  "request-screen",
  "screen-settings-fallback",
  "enable-retry",
  "stale-read",
  "refresh-on-return",
  "busy-focus",
  "unmount",
  "unsupported",
  "read-retry",
  "english",
  "scope",
]) {
  test(`computer use settings: ${scenario}`, () => {
    const result = Bun.spawnSync({
      cmd: [
        process.execPath,
        fileURLToPath(new URL("./ComputerUseSettings.interaction.fixture.tsx", import.meta.url)),
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
}
