import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

test("settings and activity navigation wait for the real menu's modal cleanup", () => {
  const result = Bun.spawnSync({
    cmd: [process.execPath, fileURLToPath(new URL("./SettingsMenu.fixture.tsx", import.meta.url))],
    stdout: "pipe",
    stderr: "pipe",
  });
  expect({ exitCode: result.exitCode, stderr: result.stderr.toString() }).toEqual({
    exitCode: 0,
    stderr: "",
  });
});
