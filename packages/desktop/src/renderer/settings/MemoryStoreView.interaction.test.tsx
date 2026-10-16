import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createBunTestEnvironment } from "../../../../../scripts/bun-test-completion.mjs";

describe("memory pin completion after a scope change", () => {
  test.each([
    "same-scope",
    "late-read",
    "late-save",
    "late-read-error",
    "late-save-error",
    "late-refresh-selected",
    "return-to-original-scope",
  ])("%s", (scenario) => {
    const directory = mkdtempSync(join(tmpdir(), "codeshell-memory-pin-ui-"));
    try {
      const result = Bun.spawnSync({
        cmd: [
          process.execPath,
          fileURLToPath(new URL("./MemoryStoreView.interaction.fixture.tsx", import.meta.url)),
          scenario,
        ],
        env: createBunTestEnvironment(process.env, directory),
        stdout: "pipe",
        stderr: "pipe",
        timeout: 10_000,
        killSignal: "SIGKILL",
        maxBuffer: 1024 * 1024,
      });
      expect({ exitCode: result.exitCode, stderr: result.stderr.toString() }).toEqual({
        exitCode: 0,
        stderr: "",
      });
      const receipt = JSON.parse(result.stdout.toString());
      expect(receipt).toMatchObject({
        scenario,
        passed: true,
        deniedFetches: 0,
        unhandled: [],
      });
      console.log(JSON.stringify(receipt));
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
