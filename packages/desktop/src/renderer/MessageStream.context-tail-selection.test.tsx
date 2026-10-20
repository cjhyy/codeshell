import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createBunTestEnvironment } from "../../../../scripts/bun-test-completion.mjs";

describe("context selection from a persisted history window", () => {
  test.each([
    "tail",
    "normal",
    "steer",
    "duplicate-text",
    "history-expand",
    "modern-client",
    "unmapped",
    "ambiguous-client",
  ])("%s", (scenario) => {
    const home = mkdtempSync(join(tmpdir(), "codeshell-context-selection-test-"));
    try {
      const result = Bun.spawnSync({
        cmd: [
          process.execPath,
          fileURLToPath(
            new URL("./MessageStream.context-tail-selection.fixture.tsx", import.meta.url),
          ),
          scenario,
        ],
        env: createBunTestEnvironment(process.env, home),
        stdout: "pipe",
        stderr: "pipe",
        timeout: 20_000,
        killSignal: "SIGKILL",
      });
      expect({
        code: result.exitCode,
        stderr: result.stderr.toString(),
        failedEvidence: result.exitCode ? result.stdout.toString() : "",
      }).toEqual({ code: 0, stderr: "", failedEvidence: "" });
      expect(JSON.parse(result.stdout.toString())).toMatchObject({
        scenario,
        passed: true,
        deniedFetches: 0,
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
