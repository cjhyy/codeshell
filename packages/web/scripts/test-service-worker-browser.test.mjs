import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  latchServiceWorkerFailure,
  resolveServiceWorkerEvidence,
  runServiceWorkerBrowser,
  serviceWorkerOperationsPassed,
} from "./test-service-worker-browser.mjs";

async function ownedDirectories(run) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "codeshell-sw-lifecycle-unit-")));
  const repo = path.join(root, "checkout");
  const home = path.join(root, "outer-home");
  await mkdir(repo);
  await mkdir(home);
  try {
    await run({ root, repo, home });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("SW evidence rejects checkout and outer HOME before creating any directory", async () => {
  await ownedDirectories(async ({ repo, home }) => {
    for (const parent of [repo, home]) {
      const requested = path.join(parent, "must-not-exist");
      await assert.rejects(resolveServiceWorkerEvidence(requested, repo, home), /Evidence must/);
      await assert.rejects(access(requested), { code: "ENOENT" });
    }
  });
});

test("SW evidence canonicalizes parent aliases before enforcing outer HOME refusal", async () => {
  await ownedDirectories(async ({ root, repo, home }) => {
    const alias = path.join(root, "home-alias");
    await symlink(home, alias, process.platform === "win32" ? "junction" : "dir");
    const requested = path.join(alias, "must-not-exist");
    await assert.rejects(
      resolveServiceWorkerEvidence(requested, repo, home),
      /Evidence must survive outer HOME cleanup/,
    );
    await assert.rejects(access(path.join(home, "must-not-exist")), { code: "ENOENT" });
  });
});

test("the actual SW CLI entry refuses outer HOME before any setup or browser launch", async () => {
  const requested = path.join(process.env.HOME, `sw-cli-refusal-${process.pid}`);
  await assert.rejects(access(requested), { code: "ENOENT" });
  await assert.rejects(
    runServiceWorkerBrowser(["--evidence-dir", requested]),
    /Evidence must survive outer HOME cleanup/,
  );
  await assert.rejects(access(requested), { code: "ENOENT" });
  const checkoutPath = fileURLToPath(new URL(`./sw-cli-refusal-${process.pid}`, import.meta.url));
  await assert.rejects(access(checkoutPath), { code: "ENOENT" });
  await assert.rejects(
    runServiceWorkerBrowser(["--evidence-dir", checkoutPath]),
    /Evidence must remain outside the checkout/,
  );
  await assert.rejects(access(checkoutPath), { code: "ENOENT" });
});

test("SW evidence owns a fresh outside directory and refuses reuse without overwriting", async () => {
  await ownedDirectories(async ({ root, repo, home }) => {
    const requested = path.join(root, "evidence");
    assert.equal(await resolveServiceWorkerEvidence(requested, repo, home), requested);
    const sentinel = path.join(requested, "sentinel");
    await writeFile(sentinel, "owned first evidence");
    await assert.rejects(resolveServiceWorkerEvidence(requested, repo, home), { code: "EEXIST" });
    assert.equal(await readFile(sentinel, "utf8"), "owned first evidence");
  });
});

const successfulOperations = () => ({
  operationsCompleted: true,
  cases: Array.from({ length: 11 }, (_, index) => `completed owned operation ${index + 1}`),
  errors: [],
  ownerDenied: [],
  recordingFailed: false,
});

test("SW HOME eligibility refuses incomplete operations and every settled late failure", () => {
  assert.equal(serviceWorkerOperationsPassed(successfulOperations()), true);
  for (const change of [
    (report) => (report.operationsCompleted = false),
    (report) => report.cases.pop(),
    (report) => report.errors.push("late renderer error"),
    (report) => report.ownerDenied.push({ kind: "http" }),
    (report) => (report.recordingFailed = true),
    (report) => (report.failure = "owned original assertion failure"),
  ]) {
    const report = successfulOperations();
    change(report);
    assert.equal(serviceWorkerOperationsPassed(report), false);
  }
});

test("SW first failure is synchronous and survives a later cleanup error", async () => {
  await ownedDirectories(async ({ root }) => {
    const filename = path.join(root, "report.json");
    const report = { status: "running", stage: "owned-operation", recordingFailed: false };
    const checkpoint = () => writeFileSync(filename, JSON.stringify(report));
    latchServiceWorkerFailure(report, Error("Owned original assertion"), checkpoint);
    const first = JSON.parse(await readFile(filename, "utf8"));
    assert.equal(first.status, "failed");
    assert.equal(first.firstError.phase, "owned-operation");
    assert.match(first.failure, /Owned original assertion/);
    report.stage = "settle-browser";
    latchServiceWorkerFailure(report, Error("Owned later cleanup failure"), checkpoint);
    assert.deepEqual(JSON.parse(await readFile(filename, "utf8")).firstError, first.firstError);
    assert.equal(report.failure, first.failure);
  });
});

test("SW diagnostic write failure is latched without throwing into cleanup", () => {
  const report = { status: "running", stage: "owned-operation", recordingFailed: false };
  assert.doesNotThrow(() =>
    latchServiceWorkerFailure(report, Error("Owned original assertion"), () => {
      throw Error("Owned diagnostic write failure");
    }),
  );
  assert.equal(report.recordingFailed, true);
  assert.match(report.failure, /Owned original assertion/);
  assert.equal(report.status, "failed");
});

test("the original eleven incognito SW operations retain their exact callbacks and assertions", async () => {
  const source = await readFile(
    new URL("./test-service-worker-browser.mjs", import.meta.url),
    "utf8",
  );
  const start = source.indexOf(
    "await page.goto(origin);",
    source.indexOf('report.status = "running"'),
  );
  const end = source.indexOf("report.operationsCompleted = true;", start);
  assert.ok(start >= 0 && end > start);
  const body = source.slice(start, source.lastIndexOf("\n", end) + 1);
  const ts = createRequire(import.meta.url)("typescript");
  const parsed = ts.createSourceFile(
    "operations.js",
    `async function preservedOperations() {\n${body}}\n`,
    ts.ScriptTarget.ESNext,
    true,
    ts.ScriptKind.JS,
  );
  const normalize = (node) => {
    const children = node.getChildren(parsed);
    return [node.kind, children.length ? null : node.getText(parsed), children.map(normalize)];
  };
  const normalized = JSON.stringify(normalize(parsed));
  assert.equal(
    createHash("sha256").update(normalized).digest("hex"),
    "7ee620baa4851b81457f555f404b08df14916cc7ec7fd6280654fe0c047a053c",
    "Keep all original operation callbacks, assertions, labels and 10s waits intact",
  );
  assert.equal((body.match(/report\.cases\.push\(/g) ?? []).length, 11);
});

test("the original exact-origin proxy and browser operation budgets remain unchanged", async () => {
  const source = await readFile(
    new URL("./test-service-worker-browser.mjs", import.meta.url),
    "utf8",
  );
  const start = source.indexOf("const server = createServer(");
  const end = source.indexOf("ownedProxy = server;", start);
  assert.ok(start >= 0 && end > start);
  const ts = createRequire(import.meta.url)("typescript");
  const parsed = ts.createSourceFile(
    "proxy.js",
    `async function preservedProxy() {\n${source.slice(start, end)}}\n`,
    ts.ScriptTarget.ESNext,
    true,
    ts.ScriptKind.JS,
  );
  const normalize = (node) => {
    const children = node.getChildren(parsed);
    return [node.kind, children.length ? null : node.getText(parsed), children.map(normalize)];
  };
  assert.equal(
    createHash("sha256")
      .update(JSON.stringify(normalize(parsed)))
      .digest("hex"),
    "66e3fe978ea07a03e5afc8fa0beb5a5e26d2e93e251ee7b115c91f710f51b126",
  );
  assert.match(source, /const deadline = Date\.now\(\) \+ 10_000;/);
  assert.match(source, /page\.setDefaultTimeout\(10_000\);/);
  assert.match(source, /timeoutMs: 120_000,/);
  assert.match(source, /headless: true,\s+timeout: 30_000,/);
  assert.match(
    source,
    /context = await browser\.newContext\(\{\s+serviceWorkers: "allow",\s+viewport: \{ width: 1280, height: 720 \},\s+\}\);/,
  );
});
