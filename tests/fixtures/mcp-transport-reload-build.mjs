/* global Bun */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpSync, copyFileSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
const [root, directory] = process.argv.slice(2);
const built = await Bun.build({
  entrypoints: [join(root, "tests/fixtures/mcp-transport-reload.fixture.ts")],
  outdir: join(directory, "build"),
  target: "node",
  format: "esm",
  sourcemap: "external",
  tsconfig: join(root, "tsconfig.json"),
  plugins: [
    {
      name: "source-js-specifiers",
      setup(build) {
        build.onResolve({ filter: /^@cjhyy\/code-shell-link$/ }, () => ({
          path: join(root, "packages/link/src/index.ts"),
        }));
        build.onResolve({ filter: /^[^./]/ }, (args) => {
          if (args.path.startsWith("node:")) return;
          return { path: Bun.resolveSync(args.path, args.resolveDir), external: true };
        });
        build.onResolve({ filter: /^\..*\.js$/ }, (args) => {
          const path = resolve(args.resolveDir, args.path.slice(0, -3) + ".ts");
          if (existsSync(path)) return { path };
        });
      },
    },
  ],
});
assert.ok(built.success, built.logs.map(String).join("\n"));
const path = join(directory, "build/mcp-transport-reload.fixture.js");
assert.ok(statSync(path).size > 0);
cpSync(join(root, "packages/core/src/prompt/sections"), join(directory, "build/sections"), {
  recursive: true,
});
// createRequire data is adjacent to the production bundle too.
for (const name of [
  "model-metadata",
  "openrouter-models",
  "deepseek-models",
  "zai-models",
  "openai-models",
  "gemini-models",
]) {
  copyFileSync(
    join(root, "packages/core/src/data", name + ".json"),
    join(directory, "build", name + ".json"),
  );
}
writeFileSync(
  join(directory, "build.json"),
  JSON.stringify({
    pid: process.pid,
    ppid: process.ppid,
    bun: process.versions.bun,
    sha256: createHash("sha256").update(readFileSync(path)).digest("hex"),
    success: true,
  }) + "\n",
);
