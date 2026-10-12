// Run the Services-owned acceptance against its actual installed public packages.
// No Host workspace dist modules or development image tags are consulted.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { lstat, readFile, mkdtemp, mkdir, rm } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { candidateFile } from "./docker-candidate-guard.mjs";
import { join, resolve } from "node:path";

const [
  installation,
  runtimeImage,
  helperImage,
  helperSource,
  evidence,
  flag,
  guardPath,
  guardHash,
  ...extra
] = process.argv.slice(2);
assert.ok(
  installation &&
    evidence &&
    !extra.length &&
    flag === "--guard" &&
    guardPath &&
    /^[a-f0-9]{64}$/.test(guardHash ?? "") &&
    [runtimeImage, helperImage].every((image) => /^sha256:[a-f0-9]{64}$/.test(image ?? "")),
  "Usage: node scripts/smoke-cloud-backup.mjs services-installation runtime-sha256-id helper-sha256-id helper-registry-digest evidence.json --guard private-manifest.json sha256",
);
const entry = join(resolve(installation), "scripts/smoke-cloud-restore.mjs");
const entryPin = candidateFile(realpathSync(entry));
const manifestFile = candidateFile(resolve(guardPath), { privateFile: true });
assert.equal(manifestFile.sha256, guardHash);
const guardManifest = JSON.parse(manifestFile.bytes);
assert.equal(guardManifest.version, 1);
assert.equal(guardManifest.runtime.imageId, runtimeImage);
const output = resolve(evidence);
try {
  await lstat(output);
  throw new Error(
    "Cloud restore evidence must be a new file; preserve earlier receipts separately.",
  );
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
const custody = await mkdtemp(join(tmpdir(), "codeshell-restore-wrapper-"));
const home = join(custody, "home");
await mkdir(home, { mode: 0o700 });
const environment = {};
for (const key of ["PATH", "LANG", "LC_ALL"])
  if (process.env[key]) environment[key] = process.env[key];
Object.assign(environment, {
  HOME: home,
  USERPROFILE: home,
  CODE_SHELL_HOME: join(home, ".code-shell"),
  DOCKER_HOST: guardManifest.docker.endpoint,
  NODE_ENV: "production",
  DISABLE_AUTOUPDATER: "1",
});
await new Promise((done, fail) => {
  const child = spawn(
    process.execPath,
    [
      entry,
      runtimeImage,
      helperImage,
      helperSource,
      resolve(evidence),
      "--guard",
      resolve(guardPath),
      guardHash,
    ],
    {
      cwd: resolve(installation),
      env: environment,
      stdio: "inherit",
    },
  );
  let interrupted = false;
  let forceTimer;
  const interrupt = () => {
    if (interrupted) return;
    interrupted = true;
    child.kill("SIGTERM");
    // The smoke first finishes/aborts its current operation, then closes the
    // controller and removes only its resources. Force exit is a last resort.
    forceTimer = setTimeout(() => child.kill("SIGKILL"), 4 * 60_000);
  };
  process.on("SIGTERM", interrupt);
  process.on("SIGINT", interrupt);
  const timer = setTimeout(interrupt, 8 * 60_000);
  const finished = () => {
    clearTimeout(timer);
    clearTimeout(forceTimer);
    process.off("SIGTERM", interrupt);
    process.off("SIGINT", interrupt);
  };
  child.once("error", (error) => {
    finished();
    fail(
      new Error(`Installed Cloud backup/restore launch failed; custody retained at ${custody}`, {
        cause: error,
      }),
    );
  });
  child.once("close", (code, signal) => {
    finished();
    if (code === 0 && signal === null && !interrupted) done();
    else
      fail(
        new Error(
          `Installed Cloud backup/restore acceptance failed (${code}); custody retained at ${custody}.`,
        ),
      );
  });
});
assert.equal(candidateFile(realpathSync(entry)).sha256, entryPin.sha256);
const metadata = await lstat(output);
assert.ok(
  metadata.isFile() && !metadata.isSymbolicLink() && metadata.size <= 1024 * 1024,
  "Expected a bounded Cloud restore evidence file",
);
const receipt = JSON.parse(await readFile(output, "utf8"));
assert.equal(receipt.candidateOnly, true);
assert.equal(receipt.passed, true, "Cloud installation restore did not pass");
assert.equal(receipt.cleanupPassed, true, "Cloud restore cleanup did not pass");
assert.equal(receipt.guard?.version, 1);
assert.equal(receipt.guard?.preCore, true);
assert.equal(receipt.guard?.hostHead, guardManifest.hostHead);
assert.equal(receipt.guard?.controllerProcesses, 3);
assert.equal(receipt.guard?.cliProcesses, 7);
assert.equal(receipt.guard?.nativeEgressAcks, 2);
assert.equal(receipt.guard?.bootstrapReleases, 2);
assert.equal(receipt.guard?.children, 0);
assert.equal(receipt.guard?.helperRemoved, true);
assert.equal(receipt.runtimeImage, runtimeImage);
assert.equal(receipt.helperImage, helperImage);
assert.equal(receipt.helperSource, helperSource);
assert.equal(receipt.helperIncludedInCandidate, false);
assert.match(receipt.runtimePlatform, /^linux\/[a-z0-9_]+$/);
assert.equal(receipt.helperPlatform, receipt.runtimePlatform);
assert.deepEqual(
  receipt.checks?.toSorted(),
  [
    "live-controller and busy-volume rejection",
    "new installation, both volume bytes, permissions and links, original preservation",
    "old session revocation, fresh login, stopped projects, actual runtime restart and rebackup",
    "corruption rejection and incomplete restore remains unstartable",
  ].sort(),
  "Cloud restore evidence must cover the complete installation workflow",
);
await rm(custody, { recursive: true });
console.log(
  "PASS: installed guarded Cloud backup/restore evidence verified before candidate export",
);
