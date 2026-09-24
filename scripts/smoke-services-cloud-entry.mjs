// Test-only cross-repository composition. No product imports sibling source files.
// Build server dependencies first; the package release smoke independently verifies tarballs.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

if (!process.argv[2])
  throw new Error("Usage: node scripts/smoke-services-cloud-entry.mjs /path/to/codeshell-services");
const source = resolve(process.argv[2]);
const root = await mkdtemp(join(tmpdir(), "codeshell-services-candidate-"));
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
try {
  await mkdir(join(root, "apps"), { recursive: true });
  await mkdir(join(root, "tests"));
  await mkdir(join(root, "node_modules/@cjhyy"), { recursive: true });
  await writeFile(join(root, "package.json"), JSON.stringify({ private: true, type: "module" }));
  await cp(join(source, "apps/cloud-control"), join(root, "apps/cloud-control"), {
    recursive: true,
  });
  for (const test of ["cloud-config.test.mjs", "cloud-control.test.mjs", "cloud-backup.test.mjs"])
    await cp(join(source, "tests", test), join(root, "tests", test));
  await symlink(
    join(repo, "packages/server"),
    join(root, "node_modules/@cjhyy/code-shell-server"),
    "dir",
  );
  const code = await new Promise((resolveCode, reject) => {
    const child = spawn(
      process.execPath,
      [
        "--test",
        "--test-concurrency=1",
        "tests/cloud-config.test.mjs",
        "tests/cloud-control.test.mjs",
        "tests/cloud-backup.test.mjs",
      ],
      { cwd: root, stdio: "inherit" },
    );
    child.once("error", reject);
    child.once("close", resolveCode);
  });
  assert.equal(code, 0, "Cloud product tests failed against candidate public server entry points");
  console.log(
    "✓ Services Cloud entry with candidate public server build; local package link is verifier-only, not a deployable dependency or real-provider acceptance.",
  );
} finally {
  await rm(root, { recursive: true, force: true });
}
