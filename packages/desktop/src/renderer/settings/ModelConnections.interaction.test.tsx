import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

describe("model connection key editing and persistence feedback", () => {
  test.each([
    "key-typing",
    "key-paste-save",
    "key-typing-save",
    "save-other-card",
    "credential-switch",
    "save-late-readback",
    "save-retry-zh",
    "save-retry-en",
    "delete-retry-zh",
    "delete-retry-en",
  ])("%s", (scenario) => {
    const result = Bun.spawnSync({
      cmd: [
        process.execPath,
        fileURLToPath(new URL("./ModelConnections.interaction.fixture.tsx", import.meta.url)),
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
