// Run the Services-owned acceptance against its actual installed public packages.
// No Host workspace dist modules or development image tags are consulted.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { join, resolve } from "node:path";

const [installation, runtimeImage, helperImage, helperSource, evidence, ...extra] =
  process.argv.slice(2);
assert.ok(
  installation &&
    evidence &&
    !extra.length &&
    [runtimeImage, helperImage].every((image) => /^sha256:[a-f0-9]{64}$/.test(image ?? "")),
  "Usage: node scripts/smoke-cloud-backup.mjs services-installation runtime-sha256-id helper-sha256-id helper-registry-digest evidence.json",
);
const entry = join(resolve(installation), "scripts/smoke-cloud-restore.mjs");
await access(entry);
await new Promise((done, fail) => {
  const child = spawn(
    process.execPath,
    [entry, runtimeImage, helperImage, helperSource, resolve(evidence)],
    {
      cwd: resolve(installation),
      stdio: "inherit",
    },
  );
  const timer = setTimeout(() => child.kill("SIGTERM"), 8 * 60_000);
  child.once("error", (error) => {
    clearTimeout(timer);
    fail(error);
  });
  child.once("close", (code) => {
    clearTimeout(timer);
    if (code === 0) done();
    else fail(new Error(`Installed Cloud backup/restore acceptance failed (${code}).`));
  });
});
