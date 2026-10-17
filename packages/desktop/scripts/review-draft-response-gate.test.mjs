import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import vm from "node:vm";
import { createReviewDraftResponseGate } from "./review-draft-response-gate.mjs";

const ids = ["owned-a", "owned-b"];
const request = (mode = "staged") => ({
  kind: "git",
  scope: { kind: "working", mode },
  instructions: "owned focus 权限",
});
const args = (id = ids[0], mode) => [{ sender: "owned event" }, id, request(mode)];
const result = { prompt: "Exact production prompt 中\n", truncated: false };
const tick = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

test("hold waits for the real listener, then releases the identical production result", async () => {
  const events = [],
    gate = createReviewDraftResponseGate(ids, {
      onRecord: (row) => {
        events.push(row);
      },
    });
  gate.arm(ids[0], "staged");
  let finish,
    received,
    settled = false;
  const input = args();
  const pending = gate.invoke((...actual) => {
    received = actual;
    return new Promise((done) => {
      finish = done;
    });
  }, input);
  pending.then(() => {
    settled = true;
  });
  await tick();
  assert.deepEqual(received, input);
  assert.equal(gate.snapshot().calls[0].status, "calling");
  assert.equal(gate.snapshot().calls[0].response, null);
  finish(result);
  await tick();
  assert.equal(settled, false);
  assert.equal(gate.snapshot().calls[0].status, "held-after-production-result");
  assert.deepEqual(gate.snapshot().calls[0].response, result);
  gate.release(1);
  assert.equal(await pending, result);
  assert.equal(gate.snapshot().calls[0].status, "returned");
  assert.deepEqual(gate.snapshot().violations, []);
  assert.deepEqual(
    events.map((row) => row.kind),
    ["response-armed", "request", "production-result", "response-released", "returned"],
  );
});

test("foreign Session/scope and malformed requests never call the production listener", async () => {
  for (const input of [
    args("foreign"),
    args(ids[0], "all"),
    [null, ids[0], { kind: "snapshot", diff: "foreign" }],
    [null, ids[0], { ...request(), instructions: "x".repeat(2001) }],
  ]) {
    const gate = createReviewDraftResponseGate(ids);
    let calls = 0;
    await assert.rejects(
      gate.invoke(() => {
        calls++;
        return result;
      }, input),
    );
    assert.equal(calls, 0);
    assert.ok(gate.snapshot().violations.length > 0);
  }
});

test("duplicate or mismatched holds and an early/wrong release fail closed", async () => {
  const gate = createReviewDraftResponseGate(ids);
  gate.arm(ids[0], "staged");
  assert.throws(() => gate.arm(ids[1], "unstaged"), /unavailable/);
  assert.throws(() => gate.release(1), /No completed/);
  let calls = 0;
  await assert.rejects(
    gate.invoke(() => {
      calls++;
      return result;
    }, args(ids[1])),
    /does not match/,
  );
  assert.equal(calls, 0);
  gate.close();
  assert.ok(gate.snapshot().violations.includes("Unsettled Review response at fixture cleanup"));
});

test("the exact production rejection propagates and cannot leave an armed hold", async () => {
  const gate = createReviewDraftResponseGate(ids);
  gate.arm(ids[0], "staged");
  const original = new Error("owned original Git failure");
  await assert.rejects(
    gate.invoke(async () => {
      throw original;
    }, args()),
    (error) => error === original,
  );
  assert.equal(gate.snapshot().calls[0].status, "rejected");
  assert.equal(gate.snapshot().calls[0].response, null);
  assert.equal(gate.snapshot().hold, null);
  assert.equal(await gate.invoke(async () => result, args(ids[1], "unstaged")), result);
});

test("only five completed production preparations fit the fixture ledger", async () => {
  const gate = createReviewDraftResponseGate(ids);
  let calls = 0;
  for (let i = 0; i < 5; i++)
    assert.equal(
      await gate.invoke(() => {
        calls++;
        return result;
      }, args()),
      result,
    );
  await assert.rejects(
    gate.invoke(() => {
      calls++;
      return result;
    }, args()),
    /extra Review/,
  );
  assert.equal(calls, 5);
  assert.equal(gate.snapshot().calls.length, 5);
});

test("cleanup releases an actual held result but records failure and closes future calls", async () => {
  const records = [];
  const gate = createReviewDraftResponseGate(ids, {
    onRecord: (row) => {
      records.push(row);
    },
  });
  gate.arm(ids[0], "staged");
  const pending = gate.invoke(async () => result, args());
  await tick();
  gate.close();
  assert.equal(await pending, result);
  assert.equal(gate.snapshot().closed, true);
  assert.ok(gate.snapshot().violations.includes("Unsettled Review response at fixture cleanup"));
  await assert.rejects(
    gate.invoke(() => result, args()),
    /closed/,
  );
  assert.equal(
    records.at(-1).kind,
    "violation",
    "Late calls remain in the durable sink after close",
  );
});

test("diagnostic IO failure never replaces a production result or rejection", async () => {
  const gate = createReviewDraftResponseGate(ids, {
    onRecord() {
      throw Error("owned disk failure");
    },
  });
  assert.equal(await gate.invoke(async () => result, args()), result);
  assert.ok(gate.snapshot().violations.includes("Review IPC diagnostic recording failed"));
  const original = new Error("original backend error");
  await assert.rejects(
    gate.invoke(() => {
      throw original;
    }, args()),
    (error) => error === original,
  );
});

test("invalid production responses fail acceptance rather than inventing a draft", async () => {
  for (const value of [
    { prompt: "", truncated: false },
    { prompt: "x".repeat(32769), truncated: true },
    { prompt: "owned", truncated: "false" },
    null,
  ]) {
    const gate = createReviewDraftResponseGate(ids);
    await assert.rejects(
      gate.invoke(() => value, args()),
      /Invalid production/,
    );
    assert.equal(gate.snapshot().calls[0].status, "rejected");
    assert.equal(gate.snapshot().calls[0].response, null);
    assert.ok(gate.snapshot().violations.length);
  }
});

test("snapshot edits cannot rewrite the original response or later evidence", async () => {
  const gate = createReviewDraftResponseGate(ids);
  await gate.invoke(() => result, args());
  const before = gate.snapshot();
  before.calls[0].response.prompt = "forged";
  before.calls[0].request.scope.mode = "unstaged";
  before.violations.push("forged");
  assert.equal(result.prompt, "Exact production prompt 中\n");
  assert.deepEqual(gate.snapshot().calls[0].response, result);
  assert.equal(gate.snapshot().calls[0].request.scope.mode, "staged");
  assert.deepEqual(gate.snapshot().violations, []);
});

test("native driver keeps actual IPC, early custody, complete operations and final HOME gates", () => {
  // Source contract only; this test never imports/launches the native driver.
  const source = readFileSync(
    new URL("./e2e-review-draft-operations.mjs", import.meta.url),
    "utf8",
  ).replace(/\r\n?/g, "\n");
  const compact = source.replace(/\s+/g, "");
  assert.ok(source.includes("state.gate.invoke(listener,args)"));
  assert.ok(source.includes('return deny("agent:msg")'));
  assert.ok(
    source.includes(
      'if(args?.some(arg=>String(arg).includes("agent-server-stdio")))return deny("Worker")',
    ),
  );
  assert.ok(
    source.indexOf("monitor = watchElectronTestProcess") <
      source.indexOf("app = await launchCodeShellElectron"),
  );
  assert.match(source, /finally\s*\{\s*children\.spawn = originalSpawn;/);
  assert.ok(compact.includes("assert.equal(captured,app.process())"));
  assert.ok(compact.includes("assert.deepEqual(report.mainExit,{code:0,signal:null})"));
  assert.ok(compact.includes("row.pid===captured.pid&&row.ppid===process.pid&&row.birth"));
  assert.ok(
    compact.includes(
      'operations.length===3&&!failures.length&&report.settlement?.status==="cleaned"&&report.mainExit?.code===0&&report.mainExit?.signal===null',
    ),
  );
  assert.ok(
    source.indexOf('diagnostics.phase("review-final-ledgers")') <
      source.indexOf("await isolated.cleanup()"),
  );
  assert.ok(
    source.indexOf('stage: "final-transport"') < source.indexOf("await isolated.cleanup()"),
  );
  assert.ok(compact.includes("assert.deepEqual(report.main.gate.violations,[])"));
  assert.ok(compact.includes("assert.equal(report.main.gate.calls.length,5)"));
  assert.ok(
    compact.includes(
      "assert.deepEqual(report.rendererSeedEvents,[first,currentScope,currentSession]",
    ),
  );
  assert.ok(
    !/getByRole\([^\n]*(?:发送|Send)|\.press\(["']Enter["']|__react(?:Fiber|Props)/.test(source),
  );
});

test("actual LF/CRLF final tail retains failed owned HOME and truthfully reports post-removal IO", async (t) => {
  const source = readFileSync(
    new URL("./e2e-review-draft-operations.mjs", import.meta.url),
    "utf8",
  ).replace(/\r\n?/g, "\n");
  for (const input of [source, source.replace(/\n/g, "\r\n")]) {
    // Normalize the in-memory test source before any multi-line delimiter.
    const normalized = input.replace(/\r\n?/g, "\n");
    const start = normalized.indexOf('  diagnostics.phase("review-home-cleanup");');
    const end = normalized.indexOf("\n}\nconsole.log(", start);
    assert.ok(start >= 0 && end > start);
    const tail = normalized.slice(start, end);
    for (const kind of [
      "passed",
      "original-failure",
      "incomplete-cases",
      "late-observer",
      "late-transport",
      "known-diagnostic-IO",
      "final-diagnostic-IO",
      "final-report-IO",
    ]) {
      const home = mkdtempSync(join(tmpdir(), "codeshell-review-draft-tail-"));
      writeFileSync(join(home, "owned-marker"), "owned bytes", { mode: 0o600 });
      t.after(() => rmSync(home, { force: true, recursive: true }));
      const failures = kind === "original-failure" ? [{ message: "original UI failure" }] : [];
      const operations = Array.from({ length: kind === "incomplete-cases" ? 2 : 3 }, () => ({}));
      const observerFailures = kind === "late-observer" ? ["late owned custody failure"] : [];
      const report = {
        status: "failed",
        privateHomeRemoved: false,
        settlement: { status: "cleaned" },
        mainExit: { code: 0, signal: null },
      };
      let recordingFailed = kind === "known-diagnostic-IO",
        caught;
      const errors = [];
      const execute = vm.runInNewContext(`(async()=>{${tail}\n})`, {
        report,
        safeMessage: (error) => String(error?.message ?? "Unknown owned Error"),
        failures,
        operations,
        observerFailures,
        captured: undefined,
        evidence: home,
        join,
        isolated: { home, cleanup: async () => rmSync(home, { recursive: true }) },
        diagnostics: {
          error: (error) => errors.push(error.message),
          phase() {},
          homeRemoved() {},
          hasRecordingFailure: () => recordingFailed,
          finalReportWritten: () => {
            if (kind === "final-diagnostic-IO") recordingFailed = true;
          },
        },
        assertSourceElectronTransportSettled: () => {
          if (kind === "late-transport") throw Error("late transport failed");
          return {};
        },
        put: async () => {
          if (kind === "final-report-IO") throw Error("final receipt IO failed");
        },
      });
      await execute().catch((error) => {
        caught = error;
      });
      const removed = ["passed", "final-diagnostic-IO", "final-report-IO"].includes(kind);
      assert.equal(existsSync(home), !removed, kind);
      assert.equal(report.privateHomeRemoved, removed, kind);
      assert.equal(report.retainedHome, removed ? null : home, kind);
      if (kind === "final-report-IO") {
        assert.equal(caught.message, "final receipt IO failed");
        assert.deepEqual(errors, [caught.message]);
      } else {
        assert.equal(caught, undefined, kind);
        assert.equal(report.status, kind === "passed" ? "passed" : "failed", kind);
      }
      if (removed && kind !== "passed")
        assert.equal(report.privateHomeRemoved, true, "Final IO cannot restore removed HOME");
    }
  }
});
