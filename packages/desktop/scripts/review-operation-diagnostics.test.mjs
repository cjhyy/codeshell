import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import vm from "node:vm";
import { createReviewOperationDiagnostics } from "./review-operation-diagnostics.mjs";

const ts = createRequire(import.meta.url)("typescript");
const driver = readFileSync(
  new URL("./e2e-review-diff-path-operations.mjs", import.meta.url),
  "utf8",
);
const parse = (text) => ts.createSourceFile("fixture.mjs", text, ts.ScriptTarget.Latest, true);
const digest = (value) => createHash("sha256").update(value).digest("hex");
function shape(node) {
  const children = [];
  ts.forEachChild(node, (child) => {
    children.push(shape(child));
  });
  return [node.kind, ts.isSourceFile(node) ? null : (node.text ?? null), children];
}
function withoutDiagnosticStatements(node) {
  if (
    ts.isExpressionStatement(node) &&
    ts.isCallExpression(node.expression) &&
    node.expression.expression.getText().startsWith("diagnostics.")
  )
    return null;
  const children = [];
  ts.forEachChild(node, (child) => {
    const value = withoutDiagnosticStatements(child);
    if (value) children.push(value);
  });
  return [node.kind, ts.isSourceFile(node) ? null : (node.text ?? null), children];
}
function fixture(t, options = {}) {
  const evidence = mkdtempSync(join(tmpdir(), "codeshell-review-diagnostic-test-"));
  t.after(() => rmSync(evidence, { recursive: true, force: true }));
  const controller = new EventEmitter();
  const diagnostics = createReviewOperationDiagnostics({
    evidence,
    ownedRoots: [evidence],
    controller,
    ...options,
  });
  const read = () => JSON.parse(readFileSync(join(evidence, "diagnostics.json"), "utf8"));
  const journal = () =>
    readFileSync(join(evidence, "diagnostics.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
  return { evidence, controller, diagnostics, read, journal };
}
function child() {
  return Object.assign(new EventEmitter(), {
    pid: 42,
    exitCode: null,
    signalCode: null,
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
  });
}
function actualSignalCallback(diagnostics, kill) {
  let callback;
  const visit = (node) => {
    if (ts.isPropertyAssignment(node) && node.name.getText() === "signalProcess")
      callback = node.initializer.getText();
    ts.forEachChild(node, visit);
  };
  visit(parse(driver));
  assert.ok(callback);
  return vm.runInNewContext(callback, { diagnostics, process: { kill } });
}

test("early pending, progress and controller exit remain distinct from final/Main success", (t) => {
  const { diagnostics, read, journal, controller } = fixture(t);
  assert.equal(read().status, "incomplete");
  assert.equal(read().main.exitObserved, null);
  assert.equal(journal()[0].kind, "initial-pending");
  diagnostics.phase("review-ui-operations");
  diagnostics.caseCompleted("Returned owned Review card", 1);
  controller.emit("exit", 1);
  assert.equal(read().finalReportWritten, false);
  assert.equal(read().completedCases.length, 1);
  assert.equal(read().main.exitObserved, null);
  assert.equal(read().controllerExit.code, 1);
  assert.match(read().controllerExit.boundary, /not the Main/);
});

test("actual signal callback persists original identity error before cleanup/signal and records byte ordering", (t) => {
  const { diagnostics, read, journal, evidence } = fixture(t);
  const main = child();
  diagnostics.observeChild(main);
  diagnostics.phase("harness-main-identity");
  main.stderr.emit("data", Buffer.from("owned original stderr\n"));
  const original = new Error("Resulting promise was garbage collected.");
  original.stack = `Error: GC\n    at owned (${evidence}/fixture.mjs:197:38)\n    at foreign (/operator/private.mjs:1:1)`;
  diagnostics.error(original, main);
  assert.equal(read().diagnostics.firstError.child.exitObserved, false);
  const cleanup = diagnostics.cleanup("harness-error", main);
  diagnostics.request(cleanup, "monitor.terminate", main);
  let calls = 0;
  actualSignalCallback(diagnostics, (pid, signal) => {
    calls++;
    assert.equal(pid, 42);
    assert.equal(signal, "SIGTERM");
    const saved = read();
    assert.equal(saved.diagnostics.signals.length, 1);
    assert.equal(saved.diagnostics.firstError.message, original.message);
  })(42, "SIGTERM");
  main.stderr.emit("data", Buffer.from("owned later stderr\n"));
  main.exitCode = 1;
  main.emit("exit", 1, null);
  main.emit("close", 1, null);
  diagnostics.settled(cleanup, main);
  diagnostics.error(new Error("Later normal-exit assertion"), main);
  assert.equal(calls, 1);
  assert.match(read().diagnostics.firstError.stack, /fixture.mjs:197:38/);
  assert.doesNotMatch(read().diagnostics.firstError.stack, /operator/);
  const events = journal();
  const at = (kind) => events.findIndex((x) => x.kind === kind);
  assert.ok(at("main-stdio") < at("first-error"));
  assert.ok(at("first-error") < at("cleanup-request"));
  assert.ok(at("cleanup-request") < at("observed-cleanup-signal-request"));
  assert.ok(
    at("observed-cleanup-signal-request") < events.findLastIndex((x) => x.kind === "main-stdio"),
  );
  assert.ok(at("observed-cleanup-signal-request") < at("child-exit"));
  assert.equal(read().diagnostics.cleanups[0].requests[0].before.exitObserved, false);
  assert.equal(read().main.exitCode, 1);
});

test("logger IO failure and hostile errors never skip the actual authorized delegate", (t) => {
  const { diagnostics } = fixture(t, {
    io: {
      appendFileSync() {
        throw Error("disk full");
      },
      writeFileSync() {
        throw Error("disk full");
      },
      renameSync() {
        throw Error("disk full");
      },
    },
  });
  const hostile = new Proxy(
    {},
    {
      get() {
        throw Error("private getter contents");
      },
    },
  );
  assert.doesNotThrow(() => diagnostics.error(hostile));
  let delegated = 0;
  actualSignalCallback(diagnostics, () => {
    delegated++;
  })(42, "SIGTERM");
  assert.equal(delegated, 1);
  assert.equal(diagnostics.hasRecordingFailure(), true);
  assert.equal(diagnostics.receipt.diagnostics.firstError.message, "Uninspectable thrown value");
  assert.doesNotMatch(JSON.stringify(diagnostics.receipt), /private getter contents/);
  assert.throws(
    () =>
      actualSignalCallback(diagnostics, () => {
        throw Error("actual signal rejected");
      })(42, "SIGKILL"),
    /actual signal rejected/,
  );
});

test("atomic snapshot rename fault preserves prior pending plus synchronous first-error journal", (t) => {
  let refuse = false;
  const { diagnostics, read, journal } = fixture(t, {
    io: {
      appendFileSync,
      writeFileSync,
      renameSync(...args) {
        if (refuse) throw Error("rename refused");
        return renameSync(...args);
      },
    },
  });
  refuse = true;
  diagnostics.error(new Error("Original metadata rejection"));
  assert.equal(read().status, "incomplete");
  assert.equal(read().diagnostics.firstError, null);
  assert.equal(
    journal().find((x) => x.kind === "first-error").observation.message,
    "Original metadata rejection",
  );
  assert.equal(diagnostics.hasRecordingFailure(), true);
});

test("terminal controller diagnostic write failure is nonzero without claiming a Main exit", (t) => {
  let refuse = false;
  const { diagnostics, read, controller } = fixture(t, {
    io: {
      appendFileSync,
      writeFileSync,
      renameSync(...args) {
        if (refuse) throw Error("terminal snapshot write refused");
        return renameSync(...args);
      },
    },
  });
  refuse = true;
  controller.emit("exit", 0);
  assert.equal(controller.exitCode, 1);
  assert.equal(diagnostics.hasRecordingFailure(), true);
  assert.equal(read().main.exitObserved, null);
  assert.equal(read().controllerExit, null);
});

test("raw buffers have one-MiB tails and byte ranges without UTF8 re-encoding", (t) => {
  const { diagnostics, read, journal, evidence } = fixture(t);
  const main = child();
  diagnostics.observeChild(main);
  const bytes = Buffer.concat([Buffer.alloc(1024 * 1024 + 9, 0xff), Buffer.from("中😀")]);
  main.stderr.emit("data", bytes);
  main.stderr.emit("data", Buffer.from([0xfe, 0x80]));
  const expected = Buffer.concat([bytes, Buffer.from([0xfe, 0x80])]).subarray(-1024 * 1024);
  assert.deepEqual(readFileSync(join(evidence, "main.stderr.log")), expected);
  assert.equal(read().logs.stderr.observedBytes, bytes.length + 2);
  assert.equal(read().logs.stderr.retainedBytes, 1024 * 1024);
  assert.equal(read().logs.stderr.truncated, true);
  const chunks = journal().filter((x) => x.kind === "main-stdio");
  assert.deepEqual(
    chunks.map((x) => [x.firstByte, x.lastByte]),
    [
      [0, bytes.length],
      [bytes.length, bytes.length + 2],
    ],
  );
  if (process.platform !== "win32")
    assert.equal(statSync(join(evidence, "main.stderr.log")).mode & 0o777, 0o600);
});

test("bounded journal/case/first-error caps cannot silently become final pass", (t) => {
  const { diagnostics, read, evidence } = fixture(t);
  diagnostics.error(new Error("x".repeat(12000)));
  for (let n = 0; n < 400; n++) diagnostics.caseCompleted("case".repeat(100), n);
  assert.equal(read().diagnostics.firstError.message.length, 4096);
  assert.equal(read().completedCases.length, 11);
  assert.equal(read().journalTruncated, true);
  assert.equal(read().finalReportWritten, false);
  assert.equal(diagnostics.hasRecordingFailure(), true);
  assert.ok(statSync(join(evidence, "diagnostics.jsonl")).size <= 512 * 1024);
});

async function actualFinalTail(t, kind, driverSource = driver) {
  driverSource = driverSource.replace(/\r\n?/g, "\n");
  let refuseFinalSnapshot = false;
  const { diagnostics, evidence, read } = fixture(t, {
    io: {
      appendFileSync,
      writeFileSync,
      renameSync(...args) {
        if (refuseFinalSnapshot) throw Error("final diagnostic write refused");
        return renameSync(...args);
      },
    },
  });
  const ownedHome = mkdtempSync(join(tmpdir(), "codeshell-review-tail-home-"));
  t.after(() => rmSync(ownedHome, { recursive: true, force: true }));
  let removed = false;
  const failures = [],
    observerFailures = [],
    rendererErrors = [];
  const report = {
    status: "failed",
    privateHomeRemoved: false,
    settlement: { status: "cleaned" },
    mainExit: { code: 0, signal: null },
    failures,
  };
  if (kind === "late-renderer") rendererErrors.push([new Error("late renderer error")]);
  if (kind === "late-observer") observerFailures.push("late custody failure");
  if (kind === "diagnostic-IO") diagnostics.phase("unknown phase");
  const tail = driverSource.slice(
    driverSource.indexOf("  report.rendererErrors = rendererErrors.flat()"),
    driverSource.indexOf(
      "\n}\nconsole.log(",
      driverSource.indexOf("  report.rendererErrors = rendererErrors.flat()"),
    ),
  );
  const run = vm.runInNewContext(`(async()=>{${tail}\n})`, {
    diagnostics,
    report,
    failures,
    observerFailures,
    rendererErrors,
    evidence,
    captured: undefined,
    join,
    readFile: async () => "",
    put: async (_path, value) => {
      if (kind === "final-report-IO" && value === report) throw Error("final report write refused");
      if (kind === "final-diagnostic-IO" && value === report) refuseFinalSnapshot = true;
    },
    isolated: {
      home: ownedHome,
      cleanup: async () => {
        removed = true;
        rmSync(ownedHome, { recursive: true });
      },
    },
  });
  let error;
  await run().catch((failure) => {
    error = failure;
  });
  return { report, removed, exists: existsSync(ownedHome), diagnostic: read(), error };
}
test("actual final-tail late renderer/observer/diagnostic faults physically retain HOME", async (t) => {
  for (const kind of ["late-renderer", "late-observer", "diagnostic-IO"]) {
    const value = await actualFinalTail(t, kind);
    assert.equal(value.report.status, "failed", kind);
    assert.equal(value.removed, false, kind);
    assert.equal(value.exists, true, kind);
    assert.equal(value.report.privateHomeRemoved, false, kind);
  }
});
test("actual unchanged success HOME criteria still remove owned HOME after all late gates", async (t) => {
  const value = await actualFinalTail(t, "passed");
  assert.equal(value.report.status, "passed");
  assert.equal(value.removed, true);
  assert.equal(value.exists, false);
  assert.equal(value.diagnostic.finalReportWritten, true);
  assert.equal(value.diagnostic.acceptanceResult, "passed");
});

test("post-removal final diagnostic IO cannot leave a passed report or claim HOME retained", async (t) => {
  const value = await actualFinalTail(t, "final-diagnostic-IO");
  assert.equal(value.report.status, "failed");
  assert.equal(value.report.privateHomeRemoved, true);
  assert.equal(value.exists, false);
  assert.ok(
    value.report.failures.some(
      (row) => row.message === "Review diagnostic recording failed/truncated",
    ),
  );
});

test("original final report write rejection is latched and remains an uncaught driver failure", async (t) => {
  const value = await actualFinalTail(t, "final-report-IO");
  assert.match(value.error.message, /final report write refused/);
  assert.equal(value.diagnostic.diagnostics.firstError.message, "final report write refused");
  assert.equal(value.diagnostic.finalReportWritten, false);
  assert.equal(value.report.privateHomeRemoved, true);
  assert.equal(value.exists, false);
});

test("actual LF and CRLF driver sources execute identical success, late-failure and final-IO gates", async (t) => {
  const lf = driver.replace(/\r\n?/g, "\n");
  for (const source of [lf, lf.replace(/\n/g, "\r\n")]) {
    for (const kind of [
      "passed",
      "late-renderer",
      "late-observer",
      "diagnostic-IO",
      "final-diagnostic-IO",
      "final-report-IO",
    ]) {
      const value = await actualFinalTail(t, kind, source);
      const removed = ["passed", "final-diagnostic-IO", "final-report-IO"].includes(kind);
      assert.equal(value.removed, removed, kind);
      assert.equal(value.exists, !removed, kind);
      assert.equal(value.report.privateHomeRemoved, removed, kind);
      if (kind === "final-report-IO") {
        assert.match(value.error.message, /final report write refused/);
        assert.equal(value.diagnostic.diagnostics.firstError.message, "final report write refused");
        assert.equal(value.diagnostic.finalReportWritten, false);
      } else {
        assert.equal(value.error, undefined, kind);
        assert.equal(value.report.status, kind === "passed" ? "passed" : "failed", kind);
        if (kind === "final-diagnostic-IO")
          assert.ok(
            value.report.failures.some(
              (row) => row.message === "Review diagnostic recording failed/truncated",
            ),
          );
        else {
          assert.equal(value.diagnostic.finalReportWritten, true, kind);
          assert.equal(value.diagnostic.acceptanceResult, value.report.status, kind);
        }
      }
    }
  }
});

test("original eleven-operation body, all assertions and budgets retain their frozen syntax", () => {
  function normalizeReviewScopeMenuBarrier(source) {
    const originalSelection = [
      '  await review.getByRole("button", { name: /^(选择审查范围|Choose review scope)$/ }).click();',
      '  await win.getByRole("menuitem", { name: /^(已暂存|Staged)$/ }).click();',
      "",
    ].join("\n");
    const expectedBarrier = [
      '  const scopeTrigger = review.getByRole("button", { name: /^(选择审查范围|Choose review scope)$/, includeHidden: true });',
      "  await scopeTrigger.click();",
      '  const scopeMenuId = await scopeTrigger.getAttribute("aria-controls");',
      '  assert.ok(scopeMenuId, "Opened Review scope menu must expose its content identity");',
      "  const scopeMenu = win.locator(`[id=${JSON.stringify(scopeMenuId)}]`);",
      '  await scopeMenu.getByRole("menuitem", { name: /^(已暂存|Staged)$/ }).click();',
      '  await scopeMenu.waitFor({ state: "hidden" });',
      "",
    ].join("\n");
    const marker = "  const scopeTrigger = review.getByRole(";
    const start = source.indexOf(marker);
    const end = source.indexOf(
      '  await review.getByText("new-normal", { exact: true }).waitFor();',
      start,
    );
    assert.notEqual(start, -1, "Review menu close barrier must be present");
    assert.notEqual(end, -1, "Review menu close barrier must precede the original card wait");
    assert.equal(source.indexOf(marker, start + 1), -1, "Review menu close barrier must be unique");
    assert.deepEqual(
      shape(parse(`async function proof(){\n${source.slice(start, end)}\n}`)),
      shape(parse(`async function proof(){\n${expectedBarrier}\n}`)),
      "Review menu identity, scoped selection and hidden wait must retain their exact syntax",
    );
    return source.slice(0, start) + originalSelection + source.slice(end);
  }
  const normalizedDriver = normalizeReviewScopeMenuBarrier(driver);
  const start = normalizedDriver.indexOf('  let review = await openPanel("review");');
  const end = normalizedDriver.indexOf("\n} catch (error) {", start);
  const body = normalizedDriver
    .slice(start, end)
    .replace(/^\s*diagnostics\.caseCompleted[^\n]*\n/gm, "");
  assert.equal(
    digest(JSON.stringify(shape(parse(`async function proof(){\n${body}\n}`)))),
    "d14e9354f2d72da3666807d3d85dbf18625d4764ff91dcd6710d127f05cf050c",
  );
  const setup = driver.slice(
    driver.indexOf("  await mkdir(projectPath, { mode: 0o700 });"),
    driver.indexOf(
      '  const executable = await realpath(createRequire(import.meta.url)("electron"));',
    ),
  );
  assert.equal(
    digest(
      JSON.stringify(withoutDiagnosticStatements(parse(`async function proof(){\n${setup}\n}`))),
    ),
    "2aaaa9f49fbc1e9f98942dfca807ceeaf9d5e87c489f6fcfdd24e3e174ca78d6",
  );
  const assertions = [];
  const visit = (node) => {
    if (ts.isCallExpression(node) && node.expression.getText().startsWith("assert."))
      assertions.push(shape(node));
    ts.forEachChild(node, visit);
  };
  visit(parse(normalizedDriver));
  assert.equal(
    digest(JSON.stringify(assertions)),
    "b41c4e5b7abcf9862c7222f0ab383d815ac440cd26a7b650d07bc8b24613917e",
  );
  for (const literal of [
    "timeout: 5000",
    "win.setDefaultTimeout(10000)",
    "timeout: 2000",
    "timeoutMs: 120000",
    "bounded(app.close(), 8000",
    "bounded(processClosed, 3000",
  ])
    assert.ok(driver.includes(literal), literal);
  assert.ok(
    driver.includes(
      'if (!failures.length && report.settlement?.status === "cleaned" && report.mainExit?.code === 0)',
    ),
  );
});
