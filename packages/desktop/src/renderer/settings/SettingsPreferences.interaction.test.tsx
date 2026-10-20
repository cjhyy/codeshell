import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createBunTestEnvironment } from "../../../../../scripts/bun-test-completion.mjs";

describe("language and current system theme preference", () => {
  test.each([
    "language-card",
    "language-local-change",
    "language-storage",
    "language-clear",
    "theme-system",
    "theme-manual-after-system",
    "theme-system-after-manual",
  ])("%s", (scenario) => {
    const directory = mkdtempSync(join(tmpdir(), "codeshell-preference-ui-"));
    try {
      const result = Bun.spawnSync({
        cmd: [
          process.execPath,
          fileURLToPath(new URL("./SettingsPreferences.interaction.fixture.tsx", import.meta.url)),
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
      expect(JSON.parse(result.stdout.toString())).toMatchObject({
        scenario,
        passed: true,
        deniedFetches: 0,
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
