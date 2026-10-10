import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const [root, directory, entry] = process.argv.slice(2);
assert.ok(process.versions.bun, "The fixture compiler requires actual Bun");
const home = realpathSync(process.env.HOME);
assert.ok(home.startsWith(directory + "/"));
assert.equal(process.env.USERPROFILE, home);
assert.equal(process.env.CODE_SHELL_HOME, join(home, ".code-shell"));
const receipt = {
  pid: process.pid,
  ppid: process.ppid,
  bun: process.versions.bun,
  executable: realpathSync(process.execPath),
  homeSha256: createHash("sha256").update(home).digest("hex"),
  entrySha256: createHash("sha256").update(readFileSync(entry)).digest("hex"),
  success: false,
};
try {
  // Compile only: the target modules are never imported by this Bun process.
  // Keep the per-build resolver outside the shared Bun test process.
  const built = await globalThis.Bun.build({
    entrypoints: [entry],
    outdir: join(directory, "build"),
    target: "node",
    format: "esm",
    sourcemap: "external",
    tsconfig: join(root, "tsconfig.json"),
    plugins: [
      {
        name: "core-source-specifiers",
        setup(build) {
          build.onResolve({ filter: /^\..*\.js$/ }, (args) => {
            const source = resolve(args.resolveDir, args.path.slice(0, -3) + ".ts");
            if (existsSync(source)) return { path: source };
          });
        },
      },
    ],
  });
  assert.equal(built.success, true, built.logs.map(String).join("\n"));
  const bundle = join(directory, "build/entry.js");
  assert.ok(statSync(bundle).size > 0);
  receipt.success = true;
  receipt.bundleSha256 = createHash("sha256").update(readFileSync(bundle)).digest("hex");
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  writeFileSync(join(directory, "build-result.json"), JSON.stringify(receipt, null, 2), {
    mode: 0o600,
  });
}
