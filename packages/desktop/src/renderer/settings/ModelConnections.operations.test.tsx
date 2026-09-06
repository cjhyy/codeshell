import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

describe("model connection auxiliary operations", () => {
  for (const language of ["zh", "en"]) {
    test.each(["add", "default", "aux", "credential"])(`%s (${language})`, (operation) => {
      const result = Bun.spawnSync({
        cmd: [
          process.execPath,
          fileURLToPath(new URL("./ModelConnections.operations.fixture.tsx", import.meta.url)),
          operation,
          language,
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
});
