import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { bundleInSubprocess } from "./helpers/bundle-in-subprocess.ts";

test("native execFileNoThrow delivers empty and large UTF-8 input through EOF", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "codeshell-exec-file-stdin-"));
  try {
    bundleInSubprocess(
      [fileURLToPath(new URL("./fixtures/exec-file-stdin-native.mjs", import.meta.url))],
      temporary,
      { naming: "fixture.mjs" },
    );
    const child = Bun.spawn(["node", join(temporary, "fixture.mjs")], {
      cwd: temporary,
      stdout: "pipe",
      stderr: "pipe",
    });
    const timer = setTimeout(() => child.kill(), 10_000);
    try {
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect(code, stderr).toBe(0);
      expect(stderr).toBe("");
      expect(JSON.parse(stdout)).toEqual({ ok: true, inputs: 2 });
    } finally {
      clearTimeout(timer);
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}, 15_000);
