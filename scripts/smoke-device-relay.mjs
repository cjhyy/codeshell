// Verify the actual installed Services/Host combination before exporting a candidate.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEVICE_RELAY_ACCEPTANCE_CHECKS } from "./device-relay-acceptance-contract.mjs";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
async function boundedFile(path) {
  const metadata = await lstat(path);
  assert.ok(
    metadata.isFile() && !metadata.isSymbolicLink() && metadata.size <= 65536,
    "Expected a regular device relay evidence/manifest file no larger than 64 KiB",
  );
  return readFile(path);
}

export async function verifyInstalledDeviceRelay(installation, manifestPath, evidencePath) {
  const installed = await realpath(resolve(installation));
  const manifestFile = resolve(manifestPath);
  const evidence = resolve(evidencePath);
  const entry = join(installed, "scripts/fixtures/device-relay-acceptance/run.mjs");
  assert.equal(await realpath(entry), entry, "Relay acceptance must come from the installed tree");
  assert.equal(
    await realpath(manifestFile),
    join(installed, "device-relay-candidate.json"),
    "Relay manifest must describe the same installed candidate",
  );
  const manifestBytes = await boundedFile(manifestFile);
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  for (const name of ["hostHead", "servicesHead"])
    assert.match(manifest[name], /^[a-f0-9]{40}$/, `Missing exact ${name}`);
  assert.ok(Array.isArray(manifest.packages) && manifest.packages.length > 0);
  try {
    await lstat(evidence);
    throw new Error("Relay evidence must be a new file; preserve earlier receipts separately");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  await mkdir(dirname(evidence), { recursive: true });
  // All child test credentials/certificates live here, even if the child must be killed.
  const scratch = await mkdtemp(join(tmpdir(), "codeshell-relay-installed-"));
  try {
    await new Promise((done, fail) => {
      const child = spawn(
        process.execPath,
        [
          entry,
          evidence,
          "--candidate-manifest",
          manifestFile,
          "--services-head",
          manifest.servicesHead,
        ],
        {
          cwd: installed,
          stdio: "inherit",
          env: { ...process.env, TMPDIR: scratch, TMP: scratch, TEMP: scratch },
        },
      );
      let interrupted = false;
      let forceTimer;
      const interrupt = () => {
        if (interrupted) return;
        interrupted = true;
        child.kill("SIGTERM");
        forceTimer = setTimeout(() => child.kill("SIGKILL"), 10_000);
      };
      process.on("SIGTERM", interrupt);
      process.on("SIGINT", interrupt);
      const timer = setTimeout(interrupt, 4 * 60_000);
      const finished = () => {
        clearTimeout(timer);
        clearTimeout(forceTimer);
        process.off("SIGTERM", interrupt);
        process.off("SIGINT", interrupt);
      };
      child.once("error", (error) => {
        finished();
        fail(error);
      });
      child.once("close", (code) => {
        finished();
        if (code === 0 && !interrupted) done();
        else fail(new Error(`Installed device relay acceptance failed (${code})`));
      });
    });
    assert.equal(hash(await boundedFile(manifestFile)), hash(manifestBytes), "Candidate changed");
    const receipt = JSON.parse((await boundedFile(evidence)).toString("utf8"));
    assert.equal(receipt.candidateOnly, true);
    assert.equal(receipt.protocolVersion, 1);
    assert.equal(receipt.passed, true, "Device relay workflow did not pass");
    assert.equal(receipt.cleanupPassed, true, "Device relay cleanup did not pass");
    assert.equal(receipt.runtime, process.version);
    assert.equal(receipt.manifestSha256, hash(manifestBytes));
    assert.equal(receipt.hostHead, manifest.hostHead);
    assert.equal(receipt.servicesHead, manifest.servicesHead);
    assert.equal(receipt.details?.authShutdown?.passed, true, "Auth shutdown did not pass");
    assert.equal(
      receipt.details.authShutdown.waitedForHandlersBeforeReleasingDirectory,
      true,
      "Auth persistence must settle before releasing the directory",
    );
    assert.deepEqual(
      receipt.details.authShutdown.realScryptActions?.toSorted(),
      ["login", "setup"],
      "Setup and login must both be exercised during shutdown",
    );
    assert.deepEqual(
      receipt.results
        ?.map(({ name, status }) => ({ name, status }))
        .sort((a, b) => a.name.localeCompare(b.name)),
      DEVICE_RELAY_ACCEPTANCE_CHECKS.map((name) => ({ name, status: "pass" })).sort((a, b) =>
        a.name.localeCompare(b.name),
      ),
      "Relay evidence must cover every required network and revocation check",
    );
    console.log("PASS: installed device relay evidence verified before candidate export");
    return receipt;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

// macOS /var aliases must not silently turn a CLI invocation into a no-op.
if (process.argv[1] && (await realpath(process.argv[1])) === fileURLToPath(import.meta.url)) {
  const [installation, manifest, evidence, ...extra] = process.argv.slice(2);
  assert.ok(
    installation && manifest && evidence && !extra.length,
    "Usage: node scripts/smoke-device-relay.mjs installation manifest.json fresh-evidence.json",
  );
  await verifyInstalledDeviceRelay(installation, manifest, evidence);
}
