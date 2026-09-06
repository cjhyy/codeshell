import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

describe("digital-human library presentation interactions", () => {
  test.each(["search-zh", "search-en", "empty-market-zh", "empty-market-en", "repo-input"])(
    "%s",
    (scenario) => {
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
    },
  );
});
