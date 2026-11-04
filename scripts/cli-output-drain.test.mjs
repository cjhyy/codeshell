import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";
const { build } = createRequire(new URL("../packages/desktop/package.json", import.meta.url))(
  "esbuild",
);

const run = promisify(execFile);
test("CLI success output drains through a real pipe before exit", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cli-drain-"));
  try {
    const file = join(directory, "fixture.mjs");
    await build({
      stdin: {
        contents: `import { cliOk } from ${JSON.stringify(resolve("packages/tui/src/cli/exit.ts"))}; cliOk("x".repeat(8 * 1024 * 1024));`,
        resolveDir: process.cwd(),
      },
      outfile: file,
      bundle: true,
      platform: "node",
      format: "esm",
      logLevel: "silent",
    });
    const { stdout, stderr } = await run(process.execPath, [file], {
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
      timeout: 10_000,
    });
    assert.equal(stdout.length, 8 * 1024 * 1024 + 1);
    assert.equal(stderr, "");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
