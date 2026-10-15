import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

describe("search connection captured writes and owner lifecycle", () => {
  test.each(["snapshot-and-duplicate", "read-order", "late-successful-probe", "unmounted-probe"])(
    "%s",
    (scenario) => {
      const result = Bun.spawnSync({
        cmd: [
          process.execPath,
          fileURLToPath(new URL("./SearchConnections.interaction.fixture.tsx", import.meta.url)),
          scenario,
        ],
        stdout: "pipe",
        stderr: "pipe",
      });
      expect({ exitCode: result.exitCode, stderr: result.stderr.toString() }).toEqual({
        exitCode: 0,
        stderr: "",
      });
    },
  );
});
