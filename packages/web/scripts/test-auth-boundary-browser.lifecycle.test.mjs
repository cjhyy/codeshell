/** Pure source-contract/failure tests. Never import or execute the browser driver. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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
import vm from "node:vm";

assert.equal(process.env.NODE_ENV, "test", "Use the isolated Node smoke runner");
assert.equal(process.env.CODE_SHELL_TEST_HOME, path.join(process.env.HOME, ".code-shell"));
const ts = createRequire(import.meta.url)("typescript");
const source = await readFile(new URL("./test-auth-boundary-browser.mjs", import.meta.url), "utf8");
const parsed = ts.createSourceFile(
  "auth.js",
  source,
  ts.ScriptTarget.ESNext,
  true,
  ts.ScriptKind.JS,
);
assert.equal(parsed.parseDiagnostics.length, 0);
function all(predicate) {
  const found = [];
  function visit(node) {
    if (predicate(node)) found.push(node);
    ts.forEachChild(node, visit);
  }
  visit(parsed);
  return found;
}
const calls = (name) =>
  all((node) => ts.isCallExpression(node) && node.expression.getText(parsed) === name);
const declaration = (name) =>
  all((node) => ts.isFunctionDeclaration(node) && node.name?.text === name)[0];
function fingerprint(node) {
  const normalize = (node) => {
    const children = node.getChildren(parsed);
    return [node.kind, children.length ? null : node.getText(parsed), children.map(normalize)];
  };
  return createHash("sha256")
    .update(JSON.stringify(normalize(node)))
    .digest("hex");
}
const names = [
  "login-survives-real-tab-visibility-check",
  "old-device-401-cannot-expire-relogin",
  "explicit-logout-clears-pending-chat-state",
  "current-login-401-after-dialog-close-remains-effective",
];

// Independently calculated from frozen clean 40141406c, before lifecycle edits.
// AST tokens retain every literal/assertion while ignoring only formatting.
test("the original four Auth operation callbacks and order are unchanged", () => {
  assert.deepEqual(
    calls("run").map((node) => [node.arguments[0].text, fingerprint(node.arguments[1])]),
    [
      [names[0], "529124d66d326cc6922569b7e27265ed608ccff95e359ea8fbcd7eef8f350de9"],
      [names[1], "636decfd11e2fbc2dbae4354078dd4a85603b78b26654a170fff6b25a2248736"],
      [names[2], "c92c069b54579aec485db324117e348d56386a86276f09304c3a7c41faadb41b"],
      [names[3], "1e2cf2100406ddb81802d60734c87e78f51314c23a68a4d9aa85e85fb537fcf9"],
    ],
  );
});

test("original incognito options and 7s, 1s, 2.5s trusted native-focus budgets remain", () => {
  assert.equal(
    fingerprint(declaration("until")),
    "c60a6a60257f195d3fbf92b612b0c396f1c539261d39627d49dfd78f8483a3d0",
  );
  assert.equal(
    calls("browser.newContext").length,
    1,
    "The same boot creates all four incognito contexts",
  );
  assert.equal(
    fingerprint(calls("browser.newContext")[0].arguments[0]),
    "6f86cf5ca4217c66e0b61831068d810e5dcfe251714b9879354d39aeed801546",
  );
  assert.equal(
    fingerprint(calls("page.setDefaultTimeout")[0]),
    "32cdf8813b7ae14add61831820427c80efbee77dafc754f31a158d931f0f4d6d",
  );
  const focus = calls("run")[0].arguments[1].getText(parsed);
  assert.match(focus, /timeout: 1_000/);
  assert.match(focus, /timeout: 2_500/);
  assert.match(focus, /event\.trusted &&/);
  assert.match(focus, /trusted: event\.isTrusted/);
  assert.match(focus, /document\.visibilityState === "hidden" \|\| !document\.hasFocus\(\)/);
});

test("owned Hub HTTP behavior is unchanged and the original five network probes remain", () => {
  assert.equal(
    fingerprint(declaration("handleRequest").body),
    "5cd208756757e48822acdb80eb85cf4160908240ddbb78d73d71df02c6dba317",
  );
  const probes = all(
    (node) => ts.isForOfStatement(node) && node.initializer.getText(parsed) === "const probe",
  );
  assert.equal(probes.length, 1);
  assert.equal(probes[0].expression.elements.length, 5);
  assert.equal(
    fingerprint(probes[0].expression),
    "bb3ea2abe053d56214aa61c3d2f5d499e983901a3710764feb60ef8d5d166939",
  );
  assert.match(source, /assert\.throws\(probe, \/refused a non-fixture request\//);
});

function subjects(functions, globals = {}) {
  const context = vm.createContext(globals);
  vm.runInContext(
    functions.map((name) => declaration(name).getText(parsed)).join("\n") +
      `\nglobalThis.subject = {${functions.join(",")}};`,
    context,
  );
  return { subject: context.subject, context };
}
test("Auth evidence refuses checkout/outer HOME and canonical aliases before mkdir", async (t) => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "codeshell-auth-path-unit-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const checkout = path.join(root, "checkout"),
    home = path.join(root, "outer-home");
  await mkdir(checkout);
  await mkdir(home);
  const alias = path.join(root, "home-alias");
  await symlink(home, alias, process.platform === "win32" ? "junction" : "dir");
  const { subject } = subjects(["resolveAuthEvidence"], {
    path,
    assert,
    realpath,
    mkdir,
    mkdtemp,
    tmpdir,
  });
  for (const parent of [checkout, home, alias]) {
    const candidate = path.join(parent, "must-not-be-created");
    await assert.rejects(
      subject.resolveAuthEvidence(candidate, checkout, home),
      /Evidence must remain outside/,
    );
    await assert.rejects(access(candidate), { code: "ENOENT" });
  }
  const evidence = path.join(root, "fresh-evidence");
  assert.equal(await subject.resolveAuthEvidence(evidence, checkout, home), evidence);
  await writeFile(path.join(evidence, "sentinel"), "owned original evidence");
  await assert.rejects(subject.resolveAuthEvidence(evidence, checkout, home), { code: "EEXIST" });
  assert.equal(await readFile(path.join(evidence, "sentinel"), "utf8"), "owned original evidence");
});
test("default Auth evidence prefix is refused before mkdtemp when inside outer HOME", async () => {
  let creations = 0;
  const { subject } = subjects(["resolveAuthEvidence"], {
    path,
    assert,
    realpath,
    mkdir,
    mkdtemp() {
      creations++;
      throw Error("Must not create refused default evidence");
    },
    tmpdir,
  });
  await assert.rejects(
    subject.resolveAuthEvidence(undefined, process.cwd(), tmpdir()),
    /outside outer HOME/,
  );
  assert.equal(creations, 0);
});
function passingGate() {
  const globals = {
    reports: names.map((name) => ({ name, result: "pass" })),
    errors: [],
    blocked: [],
    unexpected: [],
    lifecycleErrors: [],
    report: {
      operationsCompleted: true,
      recordingFailed: false,
      serversClosed: { http: true, webSocket: true },
      defaultOwnerFinalChecked: true,
      browserCustody: { status: "settled" },
    },
  };
  return { ...globals, ...subjects(["authOperationsPassed"], globals) };
}

test("HOME gate rejects any original case failure, incomplete sequence, late ledger or unsettled cleanup", () => {
  assert.equal(passingGate().subject.authOperationsPassed(), true);
  for (const change of [
    (f) => {
      f.report.operationsCompleted = false;
    },
    (f) => {
      f.reports.pop();
    },
    (f) => {
      f.reports.reverse();
    },
    (f) => {
      f.reports[0].result = "fail";
    },
    (f) => {
      f.report.failure = "original assertion failed";
    },
    (f) => {
      f.errors.push("late renderer error");
    },
    (f) => {
      f.blocked.push("late denied request");
    },
    (f) => {
      f.unexpected.push("late Hub request");
    },
    (f) => {
      f.lifecycleErrors.push("late browser error");
    },
    (f) => {
      f.report.recordingFailed = true;
    },
    (f) => {
      f.report.serversClosed.http = false;
    },
    (f) => {
      f.report.serversClosed.webSocket = false;
    },
    (f) => {
      f.report.defaultOwnerFinalChecked = false;
    },
    (f) => {
      f.report.browserCustody.status = "failed";
    },
  ]) {
    const f = passingGate();
    change(f);
    assert.equal(f.subject.authOperationsPassed(), false);
  }
});

test("hostile error/stage formatting and persistence failure preserve the first cause with bounded diagnostics", () => {
  const report = { result: "running", recordingFailed: false },
    lifecycleErrors = [];
  let writes = 0;
  const { subject } = subjects(["diagnosticText", "diagnosticError", "latch"], {
    report,
    lifecycleErrors,
    failure: undefined,
    persist() {
      writes++;
      assert.equal(report.result, "fail");
      assert.ok(report.firstFailure);
      throw Error("owned disk failure");
    },
  });
  const hostile = {
    get message() {
      throw Error("message getter");
    },
    get stack() {
      throw Error("stack getter");
    },
    toString() {
      throw Error("toString");
    },
  };
  assert.doesNotThrow(() => subject.latch(hostile, hostile));
  assert.equal(report.failure, "[unprintable failure]");
  assert.equal(report.firstFailure.stage, "[unprintable diagnostic]");
  assert.equal(report.firstFailure.message, "[unprintable failure]");
  const first = JSON.stringify(report.firstFailure);
  for (let i = 0; i < 140; i++)
    assert.doesNotThrow(() => subject.latch("x".repeat(500), Error("y".repeat(8000))));
  assert.equal(JSON.stringify(report.firstFailure), first);
  assert.equal(lifecycleErrors.length, 128);
  assert.equal(lifecycleErrors[1].stage.length, 120);
  assert.equal(lifecycleErrors[1].message.length, 4096);
  assert.equal(report.recordingFailed, true);
  assert.equal(writes, 141);
});

test("public blank owner and unconditional same-custody settlement precede final HOME gate", () => {
  assert.equal(calls("custody.launchPersistentContext").length, 1);
  assert.equal(calls("chromium.launch").length, 0);
  assert.equal(calls("browser.close").length, 0, "No unsafe ordinary close fallback");
  assert.match(source, /browser = ownerContext\.browser\(\)/);
  assert.match(
    declaration("checkBlankOwner").getText(parsed),
    /assert\.deepEqual\(pages, \["about:blank"\]\)/,
  );
  assert.match(
    declaration("checkBlankOwner").getText(parsed),
    /assert\.deepEqual\(storage, \{ cookies: \[\], origins: \[\] \}\)/,
  );
  assert.match(
    declaration("checkBlankOwner").getText(parsed),
    /assert\.deepEqual\(ownerContext\.serviceWorkers\(\), \[\]\)/,
  );
  const beforeCases = source.indexOf('await run("login-survives');
  assert.ok(source.indexOf('await ownerContext.route("**/*"') < beforeCases);
  assert.ok(source.indexOf('await ownerContext.routeWebSocket("**/*"') < beforeCases);
  const settlement = source.indexOf("if (custody) await custody.settle()");
  const homeGate = source.indexOf("custody.cleanupPrivateHome(");
  assert.ok(settlement > beforeCases && homeGate > settlement);
  assert.ok(source.indexOf("report.serversClosed.http = true") < homeGate);
  assert.ok(source.indexOf("report.serversClosed.webSocket = true") < homeGate);
  assert.ok(source.indexOf('persist("settled-ledgers")') < homeGate);
  assert.match(source.slice(homeGate), /acceptancePassed: authOperationsPassed\(\)/);
});
