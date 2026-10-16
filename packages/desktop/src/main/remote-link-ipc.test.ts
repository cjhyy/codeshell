import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertBunTestCompletion,
  createBunTestEnvironment,
} from "../../../../scripts/bun-test-completion.mjs";

if (process.env.CODESHELL_REMOTE_LINK_IPC_FIXTURE === "1") {
  await import("./remote-link-ipc.fixture");
} else {
  test("Link snapshot IPC preserves catalog caching and owner authority in an isolated worker", async () => {
    // Electron module mocks and the exact-origin fetch guard stay in a separate
    // process so this test cannot change another suite's native Host wiring.
    const directory = mkdtempSync(join(tmpdir(), "codeshell-link-ipc-test-"));
    const report = join(directory, "junit.xml");
    try {
      const child = Bun.spawn(
        [
          process.execPath,
          "test",
          fileURLToPath(import.meta.url),
          "--reporter",
          "junit",
          "--reporter-outfile",
          report,
        ],
        {
          env: {
            ...createBunTestEnvironment(process.env, directory),
            CODESHELL_REMOTE_LINK_IPC_FIXTURE: "1",
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      if (exitCode !== 0) throw new Error(`${stdout}\n${stderr}`.trim());
      expect(assertBunTestCompletion(report)).toEqual({ tests: 7, skipped: 0 });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 20_000);
}
