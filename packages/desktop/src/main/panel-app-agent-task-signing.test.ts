import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertBunTestCompletion,
  createBunTestEnvironment,
} from "../../../../scripts/bun-test-completion.mjs";

if (process.env.CODESHELL_PANEL_TASK_SIGNING_FIXTURE === "1") {
  await import("./panel-app-agent-task-signing.fixture");
} else {
  test("Panel task signing preserves ownership through the SDK in an isolated worker", async () => {
    // Keep the guard and any SDK-captured transports out of sibling test modules.
    const directory = mkdtempSync(join(tmpdir(), "codeshell-panel-task-signing-test-"));
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
            CODESHELL_PANEL_TASK_SIGNING_FIXTURE: "1",
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
      expect(assertBunTestCompletion(report)).toEqual({ tests: 14, skipped: 0 });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 20_000);
}
