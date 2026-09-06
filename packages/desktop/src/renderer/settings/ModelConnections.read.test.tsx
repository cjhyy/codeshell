import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

describe("model connection complete read snapshots", () => {
  test.each(["initial-catalog", "initial-settings", "scope", "unmount"])("%s", (scenario) => {
    const result = Bun.spawnSync({
      cmd: [
        process.execPath,
        fileURLToPath(new URL("./ModelConnections.read.fixture.tsx", import.meta.url)),
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
