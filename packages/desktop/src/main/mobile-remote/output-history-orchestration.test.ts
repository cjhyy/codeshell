import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertBunTestCompletion,
  createBunTestEnvironment,
} from "../../../../../scripts/bun-test-completion.mjs";

if (process.env.CODESHELL_HISTORY_AUTHORITY_FIXTURE === "1") {
  await import("./output-history-orchestration.fixture.js");
} else {
  test("history recovery uses real project/Session authority in an isolated Host", async () => {
    const directory = mkdtempSync(join(tmpdir(), "mobile-history-authority-"));
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
            CODESHELL_HISTORY_AUTHORITY_FIXTURE: "1",
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      if (code !== 0) throw new Error(`${stdout}\n${stderr}`.trim());
      expect(assertBunTestCompletion(report)).toEqual({ tests: 3, skipped: 0 });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 20_000);
}
