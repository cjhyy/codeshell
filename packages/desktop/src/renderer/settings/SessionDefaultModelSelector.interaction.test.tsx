import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createBunTestEnvironment } from "../../../../../scripts/bun-test-completion.mjs";

describe("new-chat default model settings", () => {
  test.each(["save", "reset", "unavailable", "write-failure", "project"])("%s", (scenario) => {
    const directory = mkdtempSync(join(tmpdir(), "codeshell-session-default-ui-"));
    try {
      const result = Bun.spawnSync({
        cmd: [
          process.execPath,
          fileURLToPath(
            new URL("./SessionDefaultModelSelector.interaction.fixture.tsx", import.meta.url),
          ),
          scenario,
        ],
        env: createBunTestEnvironment(process.env, directory),
        stdout: "pipe",
        stderr: "pipe",
        timeout: 10_000,
        killSignal: "SIGKILL",
      });
      expect({ code: result.exitCode, stderr: result.stderr.toString() }).toEqual({
        code: 0,
        stderr: "",
      });
      expect(JSON.parse(result.stdout.toString())).toEqual({
        scenario,
        passed: true,
        deniedFetches: 0,
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
