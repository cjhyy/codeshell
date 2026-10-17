/** Native-host entry for a newly built package; never publishes or changes OS keychains. */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { constants, openSync, closeSync } from "node:fs";
import { lstat, mkdir, mkdtemp, open, realpath, writeFile } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createBunTestEnvironment } from "../../../scripts/bun-test-completion.mjs";
import { readDefaultKeychain } from "./macos-keychain-context.mjs";
import { capturePackagedAppIntegrity } from "./packaged-app-integrity.mjs";
import { watchElectronTestProcess } from "./electron-test-watchdog.mjs";

const inside = (parent, child) => {
  const path = relative(parent, child);
  return path !== "" && path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
};

export async function readPackagedUiBuildReceipt(
  file,
  { platform = process.platform, arch = process.arch, sourceHead } = {},
) {
  const info = await lstat(file);
  assert.ok(info.isFile() && !info.isSymbolicLink(), "Build receipt must be a regular file");
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  let receipt;
  try {
    const stat = await handle.stat();
    assert.ok(stat.isFile() && stat.size <= 64 * 1024, "Build receipt must be bounded");
    receipt = JSON.parse(await handle.readFile("utf8"));
  } finally {
    await handle.close();
  }
  assert.ok(["darwin", "win32", "linux"].includes(platform), "Unsupported native platform");
  assert.ok(
    platform === "darwin" ? ["arm64", "x64"].includes(arch) : arch === "x64",
    "Unsupported native runtime architecture",
  );
  assert.equal(receipt.status, "passed", "A completed package build is required");
  assert.equal(receipt.platform, platform, "Package must match the actual runner platform");
  assert.equal(receipt.arch, arch, "Package must match the actual runner architecture");
  assert.ok(/^[a-f0-9]{40,64}$/.test(sourceHead ?? ""), "Verified source commit is required");
  assert.equal(receipt.sourceHead, sourceHead, "Package must be built from this source commit");
  assert.equal(receipt.sourceDirty, false, "Package must be built from committed source");
  for (const key of ["appAsarSha256", "managedNodeManifestSha256"])
    assert.ok(/^[a-f0-9]{64}$/.test(receipt[key] ?? ""), `Build receipt requires ${key}`);
  for (const key of ["publishing", "notarization", "developerIdentity"])
    assert.equal(receipt[key], false, `Acceptance build must disable ${key}`);
  for (const key of ["output", "appRoot"])
    assert.ok(
      typeof receipt[key] === "string" && isAbsolute(receipt[key]),
      `${key} must be absolute`,
    );
  const output = await realpath(receipt.output);
  const appRoot = await realpath(receipt.appRoot);
  assert.ok((await lstat(appRoot)).isDirectory(), "Package root must be a directory");
  assert.ok(inside(output, appRoot), "Package must remain inside its owned build output");
  return { ...receipt, output, appRoot };
}

export function parsePackagedUiAcceptanceArguments(args) {
  const options = new Map();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    assert.ok(
      ["--build-receipt", "--evidence-dir", "--fixture"].includes(flag) &&
        value &&
        !options.has(flag),
      "Expected --build-receipt <file>, --evidence-dir <new-directory>, [--fixture ui|updater]",
    );
    options.set(flag, flag === "--fixture" ? value : resolve(value));
  }
  for (const key of ["--build-receipt", "--evidence-dir"])
    assert.ok(options.has(key), "Build receipt and new evidence directory are required");
  const fixture = options.get("--fixture") ?? "ui";
  assert.ok(["ui", "updater"].includes(fixture), "Only reviewed packaged fixtures are allowed");
  return {
    buildReceipt: options.get("--build-receipt"),
    evidence: options.get("--evidence-dir"),
    fixture,
  };
}

export async function runPackagedUiAcceptance(args) {
  const options = parsePackagedUiAcceptanceArguments(args);
  const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
  const sourceHead = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repository,
    encoding: "utf8",
    timeout: 5_000,
  }).trim();
  const receipt = await readPackagedUiBuildReceipt(options.buildReceipt, { sourceHead });
  const integrity = await capturePackagedAppIntegrity(receipt.appRoot);
  assert.equal(
    integrity.asarSHA256,
    receipt.appAsarSha256,
    "Application differs from build receipt",
  );
  assert.equal(
    integrity.managedNodeManifestSHA256,
    receipt.managedNodeManifestSha256,
    "Managed runtime differs from build receipt",
  );
  const evidence = options.evidence;
  await mkdir(dirname(evidence), { recursive: true, mode: 0o700 });
  const evidenceParent = await realpath(dirname(evidence));
  assert.ok(
    evidenceParent !== receipt.appRoot && !inside(receipt.appRoot, evidenceParent),
    "UI evidence must remain outside the package",
  );
  assert.equal(
    await lstat(evidence).then(
      () => true,
      (error) => {
        if (error.code === "ENOENT") return false;
        throw error;
      },
    ),
    false,
    "UI evidence directory must be new",
  );
  const scratch = await realpath(await mkdtemp(join(tmpdir(), "codeshell-package-acceptance-")));
  const environment = createBunTestEnvironment(process.env, scratch);
  const childArgs = [
    join(repository, "scripts/run-isolated-node-smoke.mjs"),
    ...(process.platform === "linux" ? ["--private-keyring"] : []),
    join(
      repository,
      `packages/desktop/scripts/e2e-${options.fixture === "updater" ? "updater" : "ui"}-packaged.mjs`,
    ),
    "--packaged-app",
    receipt.appRoot,
    "--evidence-dir",
    evidence,
  ];
  if (process.platform === "darwin") {
    const home = await realpath(userInfo().homedir);
    const reference = { version: 1, home, ...readDefaultKeychain(home) };
    const metadata = join(scratch, "default-keychain-reference.json");
    await writeFile(metadata, JSON.stringify(reference), { flag: "wx", mode: 0o600 });
    childArgs.push("--default-keychain-reference", metadata);
  }
  const stdout = openSync(join(scratch, "ui.stdout.log"), "wx", 0o600);
  const stderr = openSync(join(scratch, "ui.stderr.log"), "wx", 0o600);
  let result;
  let processSettlement;
  const observerFailures = [];
  try {
    const child = spawn(process.execPath, childArgs, {
      cwd: repository,
      env: environment,
      stdio: ["ignore", stdout, stderr],
      windowsHide: true,
    });
    const completion = new Promise((resolve) => {
      child.once("error", (error) => resolve({ status: null, signal: null, error }));
      child.once("close", (status, signal) => resolve({ status, signal }));
    });
    let monitor;
    try {
      if (child.pid)
        monitor = watchElectronTestProcess(child, {
          timeoutMs: 300_000,
          reportFailure: (message) => observerFailures.push(message),
        });
      result = await completion;
      if (monitor) processSettlement = await monitor.completed;
    } catch (error) {
      observerFailures.push("Native acceptance process identity could not be established");
      result = { status: null, signal: null, error };
      // Without a birth identity, signaling by PID is unsafe. Retain this
      // private launch context and explicitly report unproven settlement.
      child.unref();
    } finally {
      monitor?.();
    }
  } finally {
    closeSync(stdout);
    closeSync(stderr);
  }
  // Keep this scratch on failure or success. A timeout is not authorization to
  // remove any descendant's private HOME; the native fixture owns that decision.
  await mkdir(evidence, { recursive: true, mode: 0o700 });
  const passed =
    !result.error &&
    result.status === 0 &&
    !result.signal &&
    processSettlement?.status === "cleaned" &&
    observerFailures.length === 0;
  const report = {
    status: passed ? "passed" : "failed",
    fixture: options.fixture,
    sourceHead,
    platform: process.platform,
    arch: process.arch,
    appRoot: receipt.appRoot,
    appAsarSha256: integrity.asarSHA256,
    managedNodeManifestSha256: integrity.managedNodeManifestSHA256,
    code: result.status,
    signal: result.signal,
    errorCode: result.error?.code ?? null,
    processSettlement: processSettlement ?? null,
    observerFailures,
    retainedLauncherRoot: scratch,
    publishing: false,
    notarization: false,
    developerIdentity: false,
    boundary:
      options.fixture === "updater"
        ? "Actual native runner; packaged updater manifest UI, no asset download, installation or full Pet claim"
        : "Actual native runner; unpacked application UI, no installer/update or full Pet claim",
  };
  await writeFile(join(evidence, "launcher-receipt.json"), JSON.stringify(report, null, 2), {
    flag: "wx",
    mode: 0o600,
  });
  console.log(JSON.stringify({ status: report.status, evidence, scratch }));
  if (result.error) throw result.error;
  assert.ok(passed, "Native packaged UI acceptance failed; private logs retained");
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await runPackagedUiAcceptance(process.argv.slice(2));
