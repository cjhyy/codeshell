/** Verify the fixed old-reducer browser failure retains its actual owned HOME.
 * This expected negative run is separate from the ordinary eight passing cases.
 * Read-only except for a new verification receipt inside that evidence directory.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const [evidenceArgument, sourceHead] = process.argv.slice(2);
assert.equal(process.argv.length, 4, "Expected <failure-evidence-directory> <source-head>");
assert.match(sourceHead, /^[a-f0-9]{40}$/);
const repo = await realpath(fileURLToPath(new URL("../../..", import.meta.url)));
const evidence = await realpath(evidenceArgument);
const outside = (parent, child) => {
  const relative = path.relative(parent, child);
  return relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
};
assert.ok(outside(repo, evidence), "Failure evidence must be outside the checkout");
assert.ok(outside(await realpath(process.env.HOME), evidence), "Evidence must survive runner HOME");
const hash = (value) => createHash("sha256").update(value).digest("hex");
const regularBytes = async (file, limit) => {
  const info = await lstat(file);
  assert.ok(info.isFile() && !info.isSymbolicLink() && info.size <= limit);
  return readFile(file);
};
const receiptBytes = await regularBytes(path.join(evidence, "receipt.json"), 2 * 1024 * 1024);
const report = JSON.parse(receiptBytes);
const reducerRef = "a3a735643bf6acd1f53d86bb7c13112a6ca8fd18";
const reducerPath = "packages/web/src/lib/streamReducer.ts";
const reducerSHA256 = "3b3245e5be1a4c66fccb5f3494dca9b94bb81d01ebc0bbc9200773a30b02b1a5";
assert.equal(report.fixture, "real-web-subagent-state");
assert.equal(report.status, "failed");
assert.equal(report.evidence, evidence);
assert.equal(report.sourceHead, sourceHead);
assert.equal(report.sourceDirty, false);
assert.equal(report.reducerRef, reducerRef);
assert.equal(report.reducerSHA256, reducerSHA256);
assert.equal(report.privateHomeRemoved, false, "Failed UI evidence HOME must remain available");
const expectedCases = [1280, 390].flatMap((width) => [
  [`${width}-normal-completed-snapshot-send-once`, "passed"],
  [`${width}-completed-parent-child-details-send-once`, "failed"],
  [`${width}-child-error-keeps-parent-and-sibling-live-stop`, "failed"],
  [`${width}-ordered-orphan-results-clean-identically`, "failed"],
]);
assert.deepEqual(
  report.cases.map((item) => [item.name, item.status]),
  expectedCases,
);
assert.deepEqual(
  report.failures.map((item) => item.name),
  expectedCases.filter(([, status]) => status === "failed").map(([name]) => name),
);
assert.ok(report.failures.every((item) => typeof item.message === "string" && item.message));
for (const field of [
  "rendererErrors",
  "observerFailures",
  "deniedAttempts",
  "browserDenied",
  "unexpected",
  "signals",
  "finalBrowserGuardAttempts",
])
  assert.deepEqual(report[field], [], `Unexpected ${field} in the controlled UI failure`);
assert.deepEqual(report.processExit, { code: 0, signal: null });
const settlement = report.settlement;
assert.equal(settlement.status, "cleaned");
assert.equal(settlement.remainingCount, 0);
assert.equal(settlement.queryFailed, false);
assert.equal(settlement.evidenceTruncated, false);
assert.deepEqual(settlement.remaining, []);
assert.ok(settlement.ownedCount > 0 && settlement.owned.length === settlement.ownedCount);
assert.ok(settlement.owned.some((item) => item.pid === report.browserPid));
assert.ok(
  settlement.owned.every(
    (item) => Number.isSafeInteger(item.pid) && item.pid > 0 && item.ppid > 0 && item.birth,
  ),
);
assert.equal(report.negativeProbes.length, 4);
assert.ok(report.negativeProbes.every((item) => item.refused === true));

const privateRoot = path.join(evidence, "private-browser");
const home = path.join(privateRoot, "home");
const profile = path.join(home, "chromium-profile");
assert.equal(report.privateHome, home);
for (const directory of [privateRoot, home, profile]) {
  const info = await lstat(directory);
  assert.ok(info.isDirectory() && !info.isSymbolicLink());
  assert.equal(await realpath(directory), directory);
}
const profileEntries = await readdir(profile);
assert.ok(profileEntries.length > 0, "The actual browser profile must remain on disk");
assert.equal(
  hash(await regularBytes(path.join(evidence, "reducer-frozen.ts"), 256 * 1024)),
  reducerSHA256,
);
const git = (...args) =>
  execFileSync("git", args, { cwd: repo, timeout: 5000, maxBuffer: 8 * 1024 * 1024 });
assert.equal(git("rev-parse", "HEAD").toString().trim(), sourceHead);
assert.equal(git("status", "--porcelain", "--untracked-files=no").toString().trim(), "");
assert.equal(hash(git("show", `${reducerRef}:${reducerPath}`)), reducerSHA256);
assert.equal(
  report.fixtureSHA256,
  hash(git("show", `${sourceHead}:packages/web/scripts/test-subagent-state-browser.mjs`)),
);
const sources = Object.entries(report.productSources);
assert.ok(sources.length > 0 && sources.length <= 512);
for (const [relative, expected] of sources) {
  assert.ok(!path.posix.isAbsolute(relative) && !relative.split("/").includes(".."));
  assert.match(expected, /^[a-f0-9]{64}$/);
  assert.equal(
    hash(git("show", `${relative === reducerPath ? reducerRef : sourceHead}:${relative}`)),
    expected,
    `Product source mismatch: ${relative}`,
  );
}
const verification = {
  status: "passed",
  sourceHead,
  reducerRef,
  reducerSHA256,
  receiptSHA256: hash(receiptBytes),
  expectedPassedControls: 2,
  expectedFailedUICases: 6,
  privateHome: home,
  privateHomeRetained: true,
  profileEntryCount: profileEntries.length,
  processExit: report.processExit,
  settlement,
  sourceHashesVerified: sources.length,
  boundary:
    "Expected old-reducer UI failures with normal browser exit and retained owned HOME/profile. Separate from the current reducer's eight passing browser cases. No real account/provider or all-OS-descendant claim.",
};
await writeFile(
  path.join(evidence, "retention-verification.json"),
  JSON.stringify(verification, null, 2),
  { flag: "wx", mode: 0o600 },
);
console.log(
  JSON.stringify({ status: "passed", expectedFailedUICases: 6, privateHomeRetained: true }),
);
