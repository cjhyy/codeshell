import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

describe("digital-human dependency editor interactions", () => {
  test.each([
    "prototype-sources",
    "install-lock",
    "stale-preview",
    "stale-confirmation",
    "stale-install-result",
    "target-change",
    "stale-discard",
    "parent-installing",
  ])("%s", (scenario) => {
    const result = Bun.spawnSync({
      cmd: [
        process.execPath,
        fileURLToPath(new URL("./DigitalHumanEditorDialog.fixture.tsx", import.meta.url)),
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
