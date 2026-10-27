import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { bundleInSubprocess } from "./helpers/bundle-in-subprocess.ts";

// Bun can mask Node's asynchronous pipe errors. The fixture runs the actual
// adapters in native Node with CLIs that close stdin but ignore SIGTERM.
// Its executable-script fixture requires POSIX shebang support.
test.skipIf(process.platform === "win32")(
  "native CLI stdin failures settle once, stop stubborn children and permit fresh transports",
  async () => {
    const temporary = await mkdtemp(join(tmpdir(), "codeshell-stdin-native-"));
    try {
      bundleInSubprocess(
        [fileURLToPath(new URL("./fixtures/external-runtime-stdin-native.mjs", import.meta.url))],
        temporary,
        { naming: "fixture.mjs" },
      );
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
        expect(JSON.parse(stdout)).toEqual({ ok: true, roomRetries: 2, pendingRejected: 2 });
      } finally {
        clearTimeout(timer);
      }
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  },
  20_000,
);
