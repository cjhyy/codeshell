import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createBunTestEnvironment } from "../../../../scripts/bun-test-completion.mjs";

test("native snapshot/add invocations reuse real Link revisions and bind the reviewed project root", () => {
  const privateDirectory = mkdtempSync(join(tmpdir(), "cs-linked-native-ui-"));
  try {
    const result = Bun.spawnSync({
      cmd: [
        process.execPath,
        fileURLToPath(new URL("./linked-file-sources-host.fixture.ts", import.meta.url)),
      ],
      env: createBunTestEnvironment(process.env, privateDirectory),
      stdout: "pipe",
      stderr: "pipe",
      timeout: 15_000,
      killSignal: "SIGKILL",
      maxBuffer: 1024 * 1024,
    });
    expect({ exitCode: result.exitCode, stderr: result.stderr.toString() }).toEqual({
      exitCode: 0,
      stderr: "",
    });
    expect(JSON.parse(result.stdout.toString())).toEqual({ passed: true, requests: 0 });
  } finally {
    rmSync(privateDirectory, { recursive: true, force: true });
  }
});
