import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Bun neither reports EPIPE for these writes nor matches Node's stdio `close`
// accounting, so the fixture runs the real transports in native Node: a child
// that exits 0 without reading input succeeds, and a backgrounded grandchild
// holding the CLI's stdout cannot keep a room from settling.
test.skipIf(process.platform === "win32")(
  "native exit-0 broken pipes succeed and grandchild-held stdio does not wedge rooms",
  async () => {
    const temporary = await mkdtemp(join(tmpdir(), "codeshell-pipe-exit-native-"));
    try {
      const build = await Bun.build({
        entrypoints: [
          fileURLToPath(new URL("./fixtures/process-pipe-exit-native.mjs", import.meta.url)),
        ],
        naming: "fixture.mjs",
        outdir: temporary,
        target: "node",
      });
      expect(build.success).toBe(true);
      await writeFile(join(temporary, "package.json"), '{"type":"module"}');
      const child = Bun.spawn(["node", join(temporary, "fixture.mjs")], {
        cwd: temporary,
        stdout: "pipe",
        stderr: "pipe",
      });
      const timer = setTimeout(() => child.kill(), 15_000);
      try {
        const [stdout, stderr, code] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ]);
        expect(code, stderr).toBe(0);
        expect(JSON.parse(stdout)).toEqual({ ok: true, residentExited: true, codexTurns: 2 });
      } finally {
        clearTimeout(timer);
      }
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  },
  20_000,
);
