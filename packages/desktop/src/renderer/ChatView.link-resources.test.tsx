import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertBunTestCompletion,
  createBunTestEnvironment,
} from "../../../../scripts/bun-test-completion.mjs";

if (process.env.CODESHELL_FIGMA_CHAT_FIXTURE === "1") {
  await import("./ChatView.link-resources.fixture");
} else {
  test("chat Figma authorization passes every component boundary in an isolated worker", async () => {
    // The fixture replaces Radix portals. Keep its module mock outside the shared
    // renderer test process so other suites still exercise their actual dialogs.
    const directory = mkdtempSync(join(tmpdir(), "codeshell-chat-link-test-"));
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
            CODESHELL_FIGMA_CHAT_FIXTURE: "1",
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
      const output = `${stdout}\n${stderr}`;
      if (exitCode !== 0) throw new Error(output.trim());
      expect(assertBunTestCompletion(report)).toEqual({ tests: 16, skipped: 0 });
      expect(output).toMatch(/\n\s*16 pass/);
      expect(output).toMatch(/\n\s*0 fail/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 20_000);
}
