import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, delimiter } from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const { build } = createRequire(new URL("../packages/desktop/package.json", import.meta.url))(
  "esbuild",
);

test(
  "native version probe permits its parent event loop to release the child",
  {
    skip: process.platform === "win32" ? "fixture is a POSIX executable" : false,
    timeout: 15_000,
  },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "codeshell-profile-probe-"));
    const originalPath = process.env.PATH;
    let release;
    try {
      const gate = join(directory, "released");
      await writeFile(
        join(directory, "codeshell-probe-fixture"),
        `#!/usr/bin/env node
const fs = require("node:fs");
const limit = Date.now() + 3000;
function poll() {
  if (fs.existsSync(${JSON.stringify(gate)})) { console.log("fixture 1.0"); return; }
  if (Date.now() > limit) { process.exitCode = 1; return; }
  setTimeout(poll, 10);
}
poll();
`,
        { mode: 0o755 },
      );
      const bundled = join(directory, "probe.mjs");
      await build({
        entryPoints: ["packages/desktop/src/main/profile-tool-probe.ts"],
        outfile: bundled,
        bundle: true,
        platform: "node",
        format: "esm",
        logLevel: "silent",
      });
      const { probeProfileTools } = await import(pathToFileURL(bundled).href);
      process.env.PATH = `${directory}${delimiter}${originalPath ?? ""}`;
      let released = false;
      const probing = probeProfileTools(["codeshell-probe-fixture"]);
      // A synchronous probe cannot run this callback before its child times out.
      release = setTimeout(() => {
        void writeFile(gate, "ready").then(() => {
          released = true;
        });
      }, 25);
      const results = await probing;
      assert.equal(released, true);
      assert.deepEqual(results.get("codeshell-probe-fixture"), {
        status: "ok",
        output: "fixture 1.0",
      });
    } finally {
      clearTimeout(release);
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
      await rm(directory, { recursive: true, force: true });
    }
  },
);
