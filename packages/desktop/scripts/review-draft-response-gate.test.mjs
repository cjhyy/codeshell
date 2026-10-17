import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import ts from "typescript";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import vm from "node:vm";
import { createReviewDraftResponseGate } from "./review-draft-response-gate.mjs";
import {
  reconcileReviewDraftReadonlyRpcLedger,
  reviewDraftReadonlyRpcGuardSource,
} from "./review-draft-readonly-rpc-guard.mjs";

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
  assert.ok(
    source.includes("reviewDraftReadonlyRpcGuardSource(sessions.map((session) => session.id))"),
  );
  assert.ok(compact.includes("assert.deepEqual(report.main.agentMessages,[])"));
  assert.ok(compact.includes("assert.ok(report.main.readonlyAgentRequests.length>0)"));
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

function readonlyGuard(record = () => undefined) {
  const listeners = new Map();
  const state = { readonlyAgentRequests: [], agentMessages: [] };
  const denied = [],
    records = [];
  const ipcMain = {
    on(channel, listener) {
      listeners.set(channel, listener);
      return ipcMain;
    },
  };
  const source = reviewDraftReadonlyRpcGuardSource(ids);
  vm.runInNewContext(source, {
    Buffer,
    ipcMain,
    state,
    recordReviewIpc(row) {
      const result = record(row);
      records.push(JSON.parse(JSON.stringify(row)));
      return result;
    },
    deny(kind, metadata) {
      denied.push({ kind, ...JSON.parse(JSON.stringify(metadata)) });
      throw Error("Owned RPC denied");
    },
  });
  return { ipcMain, listeners, state, denied, records, source };
}
const readonlyLine = (method, params, id = "owned-rpc-1") =>
  JSON.stringify({ jsonrpc: "2.0", id, method, params });
const readonlyRequests = ids.flatMap((sessionId) => [
  ["agent/goalGet", { sessionId }],
  ["agent/backgroundWork", { sessionId }],
  ["agent/backgroundWork", { sessionId, scope: "session" }],
  ["agent/backgroundWork", { sessionId, scope: "all" }],
  ["agent/backgroundShells", { sessionId, action: "list" }],
]);

test("actual generated read guard forwards only owned read requests with exact production arguments and return", () => {
  const guard = readonlyGuard();
  const event = {},
    receiver = {},
    result = { exact: "production listener result" },
    received = [];
  guard.ipcMain.on("agent:msg", function (...args) {
    assert.equal(this, receiver);
    received.push(args);
    return result;
  });
  for (const [index, [method, params]] of readonlyRequests.entries()) {
    const line = readonlyLine(method, params, index);
    assert.equal(guard.listeners.get("agent:msg").call(receiver, event, line), result);
    assert.equal(received[index][0], event);
    assert.equal(received[index][1], line);
    assert.deepEqual(guard.records[index], {
      kind: "readonly-agent-rpc",
      method,
      sessionId: params.sessionId,
      id: index,
    });
  }
  assert.equal(guard.denied.length, 0);
  assert.equal(guard.state.readonlyAgentRequests.length, readonlyRequests.length);
  const other = () => result;
  guard.ipcMain.on("some-other-channel", other);
  assert.equal(guard.listeners.get("some-other-channel"), other);
});

test("read guard refuses turns, configuration, goal writes, shell controls and foreign or extra parameters", () => {
  const methods = [
    "agent/run",
    "agent/configure",
    "agent/forkSession",
    "agent/query",
    "agent/goalSet",
    "agent/goalUpdate",
    "agent/goalDelete",
    "agent/goalClear",
    "agent/goalExtend",
    "agent/approve",
    "agent/cancel",
    "agent/backgroundWorkCancel",
  ];
  const requests = methods.map((method) => [
    method,
    { sessionId: ids[0], task: "DO_NOT_RECORD_RAW_TASK", type: "compact" },
  ]);
  requests.push(
    ["agent/backgroundShells", { sessionId: ids[0], action: "kill", shellId: "owned-shell" }],
    ["agent/backgroundShells", { sessionId: ids[0], action: "output", shellId: "owned-shell" }],
    ["agent/goalGet", { sessionId: "foreign-session" }],
    ["agent/goalGet", { sessionId: ids[0], cwd: "/private-argv-must-not-be-recorded" }],
    ["agent/backgroundWork", { sessionId: ids[0], scope: "foreign" }],
  );
  for (const [method, params] of requests) {
    const guard = readonlyGuard();
    let calls = 0;
    guard.ipcMain.on("agent:msg", () => calls++);
    assert.throws(
      () => guard.listeners.get("agent:msg")({}, readonlyLine(method, params)),
      /Owned RPC denied/,
    );
    assert.equal(calls, 0);
    assert.equal(guard.records.length, 0);
    assert.equal(guard.denied[0].method, method);
    assert.equal(guard.denied[0].sessionId, params.sessionId);
    assert.deepEqual(Object.keys(guard.denied[0]).sort(), ["id", "kind", "method", "sessionId"]);
    assert.ok(!JSON.stringify(guard.denied).includes("DO_NOT_RECORD_RAW_TASK"));
    assert.ok(!JSON.stringify(guard.denied).includes("private-argv"));
  }
});

test("read guard rejects malformed frames and keeps all recorded metadata bounded", () => {
  const valid = JSON.parse(readonlyLine("agent/goalGet", { sessionId: ids[0] }));
  const inputs = [
    null,
    {},
    "null",
    "[]",
    "{",
    JSON.stringify({ ...valid, id: null }),
    JSON.stringify({ ...valid, id: "x".repeat(129) }),
    JSON.stringify({ ...valid, jsonrpc: "1.0" }),
    JSON.stringify({ ...valid, params: [] }),
    JSON.stringify({ ...valid, params: { sessionId: ids[0], extra: true } }),
    JSON.stringify([valid]),
    readonlyLine("agent/goalGet", { sessionId: ids[0] }) + "\n",
    "x".repeat(5000),
  ];
  const guard = readonlyGuard();
  let calls = 0;
  guard.ipcMain.on("agent:msg", () => calls++);
  for (const input of inputs) assert.throws(() => guard.listeners.get("agent:msg")({}, input));
  assert.equal(calls, 0);
  assert.ok(guard.denied.every((row) => row.method.length <= 70 && row.sessionId.length <= 128));
  assert.ok(Buffer.byteLength(JSON.stringify(guard.denied)) < 8192);
  assert.throws(
    () => vm.runInNewContext(reviewDraftReadonlyRpcGuardSource([ids[0]]), { Buffer, ipcMain: {} }),
    /Expected two owned/,
  );
});

test("read guard preserves exact production failures and refuses evidence IO failure before delegation", async () => {
  const guard = readonlyGuard(),
    error = Error("owned production failure");
  guard.ipcMain.on("agent:msg", () => {
    throw error;
  });
  assert.throws(
    () =>
      guard.listeners.get("agent:msg")({}, readonlyLine("agent/goalGet", { sessionId: ids[0] })),
    (found) => found === error,
  );
  const promise = Promise.reject(error);
  promise.catch(() => {});
  guard.ipcMain.on("agent:msg", () => promise);
  assert.equal(
    guard.listeners.get("agent:msg")({}, readonlyLine("agent/goalGet", { sessionId: ids[0] })),
    promise,
  );
  await assert.rejects(promise, (found) => found === error);
  let calls = 0;
  const broken = readonlyGuard(() => {
    throw Error("owned ledger IO failure");
  });
  broken.ipcMain.on("agent:msg", () => calls++);
  assert.throws(
    () =>
      broken.listeners.get("agent:msg")({}, readonlyLine("agent/goalGet", { sessionId: ids[0] })),
    /ledger IO failure/,
  );
  assert.equal(calls, 0);
  assert.equal(broken.denied.length, 1, "IO failure is also latched in the final denial ledger");
  const asynchronous = readonlyGuard(() => ({
    get then() {
      throw Error("must not inspect thenable");
    },
  }));
  asynchronous.ipcMain.on("agent:msg", () => calls++);
  assert.throws(
    () =>
      asynchronous.listeners.get("agent:msg")(
        {},
        readonlyLine("agent/goalGet", { sessionId: ids[0] }),
      ),
    /sink must be synchronous/,
  );
  assert.equal(calls, 0);
});

test("read metadata traffic has a finite admission cap and never records raw messages", () => {
  const guard = readonlyGuard();
  let calls = 0;
  guard.ipcMain.on("agent:msg", () => calls++);
  const line = readonlyLine("agent/goalGet", { sessionId: ids[0] });
  for (let i = 0; i < 128; i++) guard.listeners.get("agent:msg")({}, line);
  assert.throws(() => guard.listeners.get("agent:msg")({}, line));
  assert.equal(calls, 128);
  assert.equal(guard.state.readonlyAgentRequests.length, 128);
  assert.ok(
    guard.records.every((row) => Object.keys(row).sort().join(",") === "id,kind,method,sessionId"),
  );
});

test("final metadata preserves the exact Main prefix while retaining permitted reads during close", () => {
  const guard = readonlyGuard();
  guard.ipcMain.on("agent:msg", () => undefined);
  guard.listeners.get("agent:msg")({}, readonlyLine("agent/goalGet", { sessionId: ids[0] }, 1));
  const snapshot = JSON.parse(JSON.stringify(guard.state.readonlyAgentRequests));
  guard.listeners.get("agent:msg")(
    {},
    readonlyLine("agent/backgroundWork", { sessionId: ids[1], scope: "all" }, 2),
  );
  const final = reconcileReviewDraftReadonlyRpcLedger(ids, snapshot, guard.records);
  assert.deepEqual(final, {
    snapshotRecords: 1,
    lateRecords: 1,
    requests: [
      { method: "agent/goalGet", sessionId: ids[0], id: 1 },
      { method: "agent/backgroundWork", sessionId: ids[1], id: 2 },
    ],
  });
  assert.equal(snapshot.length, 1);
  assert.equal(guard.denied.length, 0);
  final.requests[0].id = "changed-copy";
  assert.equal(guard.records[0].id, 1);
});

test("post-snapshot forbidden reads or ledger IO failures still deny delegation and fail acceptance", () => {
  const guard = readonlyGuard();
  let calls = 0;
  guard.ipcMain.on("agent:msg", () => calls++);
  guard.listeners.get("agent:msg")({}, readonlyLine("agent/goalGet", { sessionId: ids[0] }, 1));
  const snapshot = JSON.parse(JSON.stringify(guard.state.readonlyAgentRequests));
  assert.throws(
    () =>
      guard.listeners.get("agent:msg")(
        {},
        readonlyLine("agent/goalUpdate", { sessionId: ids[0], objective: "never admitted" }, 2),
      ),
    /Owned RPC denied/,
  );
  assert.equal(calls, 1);
  assert.equal(guard.denied.length, 1);
  assert.deepEqual(
    reconcileReviewDraftReadonlyRpcLedger(ids, snapshot, guard.records).requests,
    snapshot,
  );
  const error = Error("owned late ledger IO failure");
  let broken = false;
  const io = readonlyGuard(() => {
    if (broken) throw error;
  });
  io.ipcMain.on("agent:msg", () => calls++);
  io.listeners.get("agent:msg")({}, readonlyLine("agent/goalGet", { sessionId: ids[0] }, 1));
  broken = true;
  assert.throws(
    () =>
      io.listeners.get("agent:msg")({}, readonlyLine("agent/goalGet", { sessionId: ids[1] }, 2)),
    (found) => found === error,
  );
  assert.equal(calls, 2);
  assert.equal(io.records.length, 1);
  assert.equal(io.denied.length, 1);
  const source = readFileSync(
    new URL("./e2e-review-draft-operations.mjs", import.meta.url),
    "utf8",
  );
  const parsed = ts.createSourceFile(
    "driver.mjs",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const gates = [];
  function visit(node) {
    if (
      ts.isIfStatement(node) &&
      node.expression.getText(parsed).includes('"denied-attempts.jsonl"')
    )
      gates.push(node);
    ts.forEachChild(node, visit);
  }
  visit(parsed);
  assert.equal(gates.length, 1);
  // Execute only the actual final denial-ledger condition, without importing the driver.
  const failures = [];
  vm.runInNewContext(gates[0].getText(parsed), {
    name: "denied-attempts.jsonl",
    content: JSON.stringify(guard.denied[0]) + "\n",
    failures,
  });
  assert.equal(failures.length, 1);
  assert.equal(failures[0].stage, "late-ledger");
});

test("final readonly sequence rejects changed prefixes, foreign metadata, extra fields and overflow", () => {
  const first = { method: "agent/goalGet", sessionId: ids[0], id: 1 };
  const row = { kind: "readonly-agent-rpc", ...first };
  for (const [snapshot, records] of [
    [[{ ...first, id: 2 }], [row]],
    [[first], []],
    [[], [{ ...row, method: "agent/goalUpdate" }]],
    [[], [{ ...row, sessionId: "foreign" }]],
    [[], [{ ...row, id: "x".repeat(129) }]],
    [[], [{ ...row, task: "must not be present" }]],
    [[], Array.from({ length: 129 }, () => row)],
  ])
    assert.throws(() => reconcileReviewDraftReadonlyRpcLedger(ids, snapshot, records));
});

function pureTypescript(
  relative,
  require = () => {
    throw Error("Unexpected runtime import");
  },
) {
  const source = readFileSync(new URL(relative, import.meta.url), "utf8");
  const exports = {};
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  vm.runInNewContext(compiled, { exports, require });
  return exports;
}

test("allowed source routes remain non-run metadata and production no-Worker fallback reads", () => {
  const fallback = pureTypescript("../src/main/agent-bridge-fallback.ts");
  const metadata = pureTypescript("../src/main/agent-run-metadata.ts", (name) => {
    assert.equal(name, "@cjhyy/code-shell-core/internal");
    return {
      isOperationBatchAuthorityFrame: () => false,
      canonicalKey() {
        throw Error("Unexpected run-only path");
      },
    };
  });
  const deps = new Proxy(
    {},
    {
      get() {
        throw Error("Read route requested run authority");
      },
    },
  );
  const sessions = new Proxy(
    {
      readActiveGoal(sid) {
        assert.ok(ids.includes(sid));
        return undefined;
      },
    },
    {
      get(target, key) {
        assert.equal(key, "readActiveGoal");
        return target[key];
      },
    },
  );
  for (const [method, params] of readonlyRequests) {
    const line = readonlyLine(method, params),
      prepared = metadata.prepareAgentRunMetadata(
        line,
        { origin: "renderer", producer: "agent:msg" },
        deps,
      );
    assert.equal(prepared.outLine, line);
    assert.equal(prepared.parsed.method, method);
    assert.equal(fallback.forkSourceSessionId(prepared.parsed), null);
    assert.equal(fallback.compactQuerySessionId(prepared.parsed), null);
    const response = JSON.parse(fallback.buildNoChildFallbackReply(prepared.parsed, sessions));
    assert.equal(response.id, "owned-rpc-1");
    if (method === "agent/goalGet") assert.equal(response.result.goal, null);
    else
      assert.deepEqual(
        response.result,
        method === "agent/backgroundWork" ? { items: [] } : { shells: [] },
      );
  }
});

test("only Electron argument binding changes the original three UI operation bodies", () => {
  const source = readFileSync(
    new URL("./e2e-review-draft-operations.mjs", import.meta.url),
    "utf8",
  ).replace(/\r\n?/g, "\n");
  const start = source.indexOf('  diagnostics.phase("review-ui-operations");');
  const end = source.indexOf("\n} catch (error) {", start);
  assert.ok(start > 0 && end > start);
  const measurementStart = source.indexOf("  report.rendererSeedObservation =", start);
  const measurementEnd = source.indexOf("  assert.deepEqual(", measurementStart);
  const measurement = measurementStart < 0 ? "" : source.slice(measurementStart, measurementEnd);
  const originalBody = source
    .slice(start, end)
    .replace(
      measurement || "no-metric-replacement",
      "  report.rendererSeedEvents = await win.evaluate(() => window.__ownedReviewSeedEvents);\n",
    )
    .replaceAll("app.evaluate((_electron, { id })", "app.evaluate(({ id })");
  assert.equal(
    createHash("sha256").update(originalBody).digest("hex"),
    "ac5e7e1f291decef502e72aefe487807340b1f58f29ce49892c6d65c1e3b2202",
  );
});

test("the actual pre-Core template parses and its IPC writer emits complete JSONL bytes", () => {
  const driver = new URL("./e2e-review-draft-operations.mjs", import.meta.url);
  const source = readFileSync(driver, "utf8");
  const parsed = ts.createSourceFile(
    "driver.mjs",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const templates = [];
  function visit(node) {
    if (
      ts.isCallExpression(node) &&
      node.expression.getText(parsed) === "put" &&
      node.arguments[0]?.getText(parsed) === "guard" &&
      ts.isTemplateExpression(node.arguments[1])
    )
      templates.push(node.arguments[1]);
    ts.forEachChild(node, visit);
  }
  visit(parsed);
  assert.equal(templates.length, 1);
  // Evaluate only the template interpolation, never the generated native imports/guard.
  const generated = vm.runInNewContext(
    templates[0].getText(parsed).replaceAll("import.meta.url", JSON.stringify(driver.href)),
    {
      JSON,
      URL,
      join,
      isolated: { home: "/owned-fixture" },
      sessions: ids.map((id) => ({ id })),
      reviewDraftReadonlyRpcGuardSource,
    },
  );
  const guard = ts.createSourceFile(
    "guard.mjs",
    generated,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  assert.deepEqual(guard.parseDiagnostics, []);
  const writer = guard.statements.filter(
    (statement) =>
      ts.isVariableStatement(statement) &&
      statement.declarationList.declarations.some((declaration) =>
        ["ipcBytes", "ipcFile", "recordReviewIpc"].includes(declaration.name.getText(guard)),
      ),
  );
  assert.equal(writer.length, 3);
  const writes = [];
  vm.runInNewContext(
    writer.map((statement) => statement.getText(guard)).join("\n") +
      '\nrecordReviewIpc({kind:"readonly-agent-rpc",method:"agent/goalGet",sessionId:"owned-a",id:1});',
    { Buffer, appendFileSync: (...args) => writes.push(args) },
  );
  assert.equal(writes.length, 1);
  assert.equal(writes[0][0], join("/owned-fixture", "review-draft-ipc.jsonl"));
  assert.equal(
    writes[0][1],
    '{"kind":"readonly-agent-rpc","method":"agent/goalGet","sessionId":"owned-a","id":1}\n',
  );
  assert.equal(writes[0][2].mode, 0o600);
  assert.equal(JSON.parse(writes[0][1]).sessionId, "owned-a");
});

function electronEvaluationSource() {
  const source = readFileSync(
    new URL("./e2e-review-draft-operations.mjs", import.meta.url),
    "utf8",
  );
  const parsed = ts.createSourceFile(
    "driver.mjs",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const calls = [];
  function visit(node) {
    if (ts.isCallExpression(node) && node.expression.getText(parsed) === "app.evaluate")
      calls.push(node);
    ts.forEachChild(node, visit);
  }
  visit(parsed);
  return { source, parsed, calls };
}

test("actual waitGate uses Electron's module plus payload signature and waits false then true", async () => {
  const { parsed } = electronEvaluationSource();
  const harnessSource = readFileSync(new URL("./electron-harness.mjs", import.meta.url), "utf8");
  const harness = ts.createSourceFile(
    "harness.mjs",
    harnessSource,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const declaration = (file, name) => {
    const node = file.statements.find(
      (node) => ts.isFunctionDeclaration(node) && node.name.text === name,
    );
    assert.ok(node, name);
    return node.getText(file).replace(/^export\s+/, "");
  };
  const electronModule = Object.freeze({ app: {}, ipcMain: {} });
  const call = { id: 1, status: "calling", response: null };
  const evaluations = [];
  const app = {
    async evaluate(predicate, arg) {
      // Public ElectronApplication.evaluate is PageFunctionOn<ElectronType,Arg>.
      const value = await predicate(electronModule, arg);
      if (typeof value === "boolean") {
        evaluations.push(value);
        if (!value)
          Object.assign(call, {
            status: "returned",
            response: { prompt: "owned original prompt" },
          });
      }
      return globalThis.structuredClone(value);
    },
  };
  const found = await vm.runInNewContext(
    [
      declaration(harness, "waitForAsyncFunction"),
      declaration(parsed, "gate"),
      declaration(parsed, "waitGate"),
      'waitGate(1,"returned")',
    ].join("\n"),
    {
      app,
      setTimeout,
      clearTimeout,
      __ownedReviewDraft: { gate: { snapshot: () => ({ calls: [call] }) } },
    },
  );
  assert.equal(found.response.prompt, "owned original prompt");
  assert.equal(found.status, "returned");
  assert.deepEqual(evaluations, [false, true]);
});

test("both actual arm callbacks bind owned Session payloads for held calls2 and4", async () => {
  const { parsed, calls } = electronEvaluationSource();
  const arm = calls.filter((node) => node.arguments[0].getText(parsed).includes(".gate.arm("));
  const release = calls.filter((node) =>
    node.arguments[0].getText(parsed).includes(".gate.release("),
  );
  assert.equal(arm.length, 2);
  assert.equal(release.length, 2);
  const gate = createReviewDraftResponseGate(ids);
  const input = args();
  const app = {
    evaluate: async (predicate, arg) => predicate(Object.freeze({ app: {}, ipcMain: {} }), arg),
  };
  const context = { app, a: { id: ids[0] }, __ownedReviewDraft: { gate } };
  assert.equal(await gate.invoke(() => result, input), result);
  for (const index of [0, 1]) {
    await vm.runInNewContext(arm[index].getText(parsed), context);
    assert.deepEqual(gate.snapshot().hold, {
      sessionId: ids[0],
      mode: "staged",
      status: "armed",
      callId: null,
    });
    const pending = gate.invoke(() => result, input);
    await tick();
    assert.equal(gate.snapshot().calls.at(-1).status, "held-after-production-result");
    await vm.runInNewContext(release[index].getText(parsed), context);
    assert.equal(await pending, result);
    if (index === 0)
      assert.equal(await gate.invoke(() => result, args(ids[0], "unstaged")), result);
  }
  assert.equal(await gate.invoke(() => result, args(ids[1])), result);
  assert.deepEqual(
    gate.snapshot().calls.map((call) => call.held),
    [false, true, false, true, false],
  );
  assert.deepEqual(gate.snapshot().violations, []);
});

test("all native evaluate payloads use the second parameter while Page signatures remain unchanged", () => {
  const { parsed, calls } = electronEvaluationSource();
  assert.equal(calls.length, 6);
  const payloads = calls.filter((node) => node.arguments.length === 2);
  assert.equal(payloads.length, 2);
  assert.ok(payloads.every((node) => node.arguments[0].parameters.length === 2));
  assert.ok(
    calls
      .filter((node) => node.arguments.length === 1)
      .every((node) => node.arguments[0].parameters.length === 0),
  );
  const wait = parsed.statements.find(
    (node) => ts.isFunctionDeclaration(node) && node.name.text === "waitGate",
  );
  const waits = [];
  function visit(node) {
    if (ts.isCallExpression(node) && node.expression.getText(parsed) === "waitForAsyncFunction")
      waits.push(node);
    ts.forEachChild(node, visit);
  }
  visit(wait);
  assert.equal(waits.length, 1);
  assert.equal(waits[0].arguments[0].getText(parsed), "app");
  assert.equal(waits[0].arguments[1].parameters.length, 2);
  assert.equal(waits[0].arguments[3].getText(parsed), "{ timeout: 5000, polling: 50 }");
});

function actualReviewPanel(win) {
  const { parsed } = electronEvaluationSource();
  const declaration = parsed.statements.find(
    (node) => ts.isFunctionDeclaration(node) && node.name.text === "reviewPanel",
  );
  assert.ok(declaration);
  return vm.runInNewContext(`(${declaration.getText(parsed)})`, { win, assert });
}

/** Pure locator contract, not Playwright/browser execution. Opacity alone is visible. */
function panelLocatorTree() {
  const clicks = [];
  const node = (attrs = {}, style = {}) => ({ attrs, style, children: [], parent: null });
  const root = node();
  const add = (parent, child) => {
    child.parent = parent;
    parent.children.push(child);
    return child;
  };
  const descendants = (parent) =>
    parent.children.flatMap((child) => [child, ...descendants(child)]);
  const visible = (item) =>
    !item ||
    (item.style.display !== "none" && item.style.visibility !== "hidden" && visible(item.parent));
  const inert = (item) => item && ("inert" in item.attrs || inert(item.parent));
  function matches(item, selector) {
    const attribute = /^\[([\w-]+)(?:="([^"]*)")?\]$/;
    const attr = (text) => {
      const match = attribute.exec(text);
      assert.ok(match, `unsupported attribute ${text}`);
      return (
        match[1] in item.attrs && (match[2] === undefined || item.attrs[match[1]] === match[2])
      );
    };
    let match = true;
    const rest = selector
      .replace(/:not\((\[[^\]]+\])\)/g, (_all, condition) => {
        match &&= !attr(condition);
        return "";
      })
      .replace(/:visible/g, () => {
        match &&= visible(item);
        return "";
      })
      .replace(/\[[^\]]+\]/g, (condition) => {
        match &&= attr(condition);
        return "";
      });
    assert.equal(rest, "", `unsupported selector ${selector}`);
    return match;
  }
  function locator(select) {
    const one = () => {
      const found = select();
      assert.equal(found.length, 1, `strict locator resolved to ${found.length} elements`);
      return found[0];
    };
    return {
      locator: (selector) =>
        locator(() =>
          select()
            .flatMap(descendants)
            .filter((item) => matches(item, selector)),
        ),
      count: async () => select().length,
      getAttribute: async (name) => one().attrs[name] ?? null,
      waitFor: async () => assert.ok(visible(one()), "locator not visible"),
      click: async () => {
        const item = one();
        assert.ok(visible(item) && !inert(item), "locator not actionable");
        clicks.push(item.name);
        item.onClick?.();
      },
    };
  }
  const toggle = add(root, node({ "data-panel-action": "toggle", "aria-pressed": "true" }));
  toggle.name = "toggle";
  function dock(name, { hidden = false, review = false, activeReview = true } = {}) {
    const surface = add(
      root,
      node(
        { "data-theme-surface": "panel", ...(hidden ? { "aria-hidden": "true", inert: "" } : {}) },
        hidden ? { opacity: 0, pointerEvents: "none" } : {},
      ),
    );
    const plus = add(surface, node({ "data-panel-action": "new-tab" }));
    plus.name = `${name}:new-tab`;
    const launcher = add(surface, node({ "data-panel-launcher": "" }));
    const pick = add(launcher, node({ "data-panel-menu-kind": "review" }));
    pick.name = `${name}:pick-review`;
    let slot, tab;
    const activateReview = () => {
      if (!slot) {
        slot = add(surface, node({ "data-panel-id": "review", "aria-labelledby": `${name}-tab` }));
        tab = add(surface, node({ role: "tab", id: `${name}-tab` }));
        tab.name = `${name}:review-tab`;
        tab.onClick = activateReview;
      }
      Object.assign(slot.attrs, { "data-panel-active": "true", "aria-hidden": "false" });
      delete slot.attrs.inert;
      slot.style.opacity = 1;
      Object.assign(launcher.attrs, { "aria-hidden": "true", inert: "" });
    };
    plus.onClick = () => {
      delete launcher.attrs["aria-hidden"];
      delete launcher.attrs.inert;
    };
    pick.onClick = activateReview;
    if (review) {
      activateReview();
      if (!activeReview) {
        Object.assign(slot.attrs, {
          "data-panel-active": "false",
          "aria-hidden": "true",
          inert: "",
        });
        slot.style.opacity = 0;
      }
    }
    return {
      surface,
      plus,
      launcher,
      pick,
      get slot() {
        return slot;
      },
      get tab() {
        return tab;
      },
    };
  }
  return { win: locator(() => [root]), dock, clicks, add, node, root, toggle };
}

test("actual panel helper excludes the retained opacity-zero Session dock before creating B Review", async () => {
  const tree = panelLocatorTree();
  tree.dock("A", { hidden: true });
  tree.dock("B");
  const panel = await actualReviewPanel(tree.win)();
  assert.equal(await panel.getAttribute("aria-labelledby"), "B-tab");
  assert.deepEqual(tree.clicks, ["B:new-tab", "B:pick-review"]);
});

test("actual panel helper ignores a hidden Session Review slot and selects only B's launcher", async () => {
  const tree = panelLocatorTree();
  tree.dock("A", { hidden: true, review: true });
  tree.dock("B");
  const panel = await actualReviewPanel(tree.win)();
  assert.equal(await panel.getAttribute("aria-labelledby"), "B-tab");
  assert.deepEqual(tree.clicks, ["B:new-tab", "B:pick-review"]);
});

test("actual panel helper activates an existing inactive Review tab only in the visible Session", async () => {
  const tree = panelLocatorTree();
  tree.dock("A", { review: true, activeReview: false });
  tree.dock("B", { hidden: true, review: true });
  const panel = await actualReviewPanel(tree.win)();
  assert.equal(await panel.getAttribute("aria-labelledby"), "A-tab");
  assert.deepEqual(tree.clicks, ["A:review-tab"]);
});

test("actual panel helper preserves strict refusal for zero or two visible docks and toggles", async () => {
  for (const count of [0, 2]) {
    const tree = panelLocatorTree();
    tree.dock("hidden", { hidden: true });
    for (let i = 0; i < count; i++) tree.dock(`visible-${i}`);
    await assert.rejects(actualReviewPanel(tree.win)());
    assert.deepEqual(tree.clicks, []);
  }
  for (const count of [0, 2]) {
    const tree = panelLocatorTree();
    tree.dock("visible");
    if (!count) tree.root.children.splice(tree.root.children.indexOf(tree.toggle), 1);
    else tree.add(tree.root, tree.node({ "data-panel-action": "toggle", "aria-pressed": "true" }));
    await assert.rejects(actualReviewPanel(tree.win)());
    assert.deepEqual(tree.clicks, []);
  }
});

test("actual panel helper never picks the first of zero or two visible new-tab controls", async () => {
  for (const count of [0, 2]) {
    const tree = panelLocatorTree(),
      dock = tree.dock("visible");
    if (!count) dock.surface.children.splice(dock.surface.children.indexOf(dock.plus), 1);
    else tree.add(dock.surface, tree.node({ "data-panel-action": "new-tab" }));
    await assert.rejects(actualReviewPanel(tree.win)());
    assert.deepEqual(tree.clicks, []);
  }
});

test("actual panel helper keeps strict tab, launcher and Review-body uniqueness within the active dock", async () => {
  for (const count of [0, 2]) {
    const tree = panelLocatorTree(),
      dock = tree.dock("visible", { review: true, activeReview: false });
    if (!count) dock.surface.children.splice(dock.surface.children.indexOf(dock.tab), 1);
    else tree.add(dock.surface, tree.node({ role: "tab", id: "visible-tab" }));
    await assert.rejects(actualReviewPanel(tree.win)());
    assert.deepEqual(tree.clicks, []);
  }
  for (const count of [0, 2]) {
    const tree = panelLocatorTree(),
      dock = tree.dock("visible");
    if (!count) dock.launcher.children.splice(dock.launcher.children.indexOf(dock.pick), 1);
    else tree.add(dock.launcher, tree.node({ "data-panel-menu-kind": "review" }));
    await assert.rejects(actualReviewPanel(tree.win)());
    assert.deepEqual(tree.clicks, ["visible:new-tab"]);
  }
  const tree = panelLocatorTree(),
    dock = tree.dock("visible", { review: true });
  tree.add(dock.surface, tree.node({ "data-panel-id": "review", "data-panel-active": "true" }));
  await assert.rejects(actualReviewPanel(tree.win)());
  assert.deepEqual(tree.clicks, []);
});

function actualSeedProtocol(observerFirst, schedule = queueMicrotask) {
  const { source, parsed } = electronEvaluationSource();
  const window = new globalThis.EventTarget();
  const drafts = { A: "old A", B: "old B" };
  const activeBucketRef = { current: "A" };
  const context = vm.createContext({
    window,
    CustomEvent: globalThis.CustomEvent,
    queueMicrotask: schedule,
    assert,
    exports: {},
    activeBucketRef,
    resolveEngineSessionIdForBucket: (bucket) => `owned-${bucket.toLowerCase()}`,
    appendReviewDraft: (bucket, text) => {
      drafts[bucket] += "\n\n" + text;
    },
    setViewMode: () => {},
    seedComposer: () => {},
  });
  const bridgeSource = readFileSync(
    new URL("../src/renderer/chat/composerSeed.ts", import.meta.url),
    "utf8",
  );
  vm.runInContext(
    ts.transpileModule(bridgeSource, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText,
    context,
  );
  const appSource = readFileSync(
    new URL("../src/renderer/app/usePanelBuckets.ts", import.meta.url),
    "utf8",
  );
  const app = ts.createSourceFile(
    "app.ts",
    appSource,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const consumers = [],
    scripts = [];
  function findConsumer(node) {
    if (ts.isCallExpression(node) && node.expression.getText(app) === "onComposerSeedRequest")
      consumers.push(node.arguments[0]);
    ts.forEachChild(node, findConsumer);
  }
  function findScript(node) {
    if (ts.isCallExpression(node) && node.expression.getText(parsed) === "win.addInitScript")
      scripts.push(node.arguments[0]);
    ts.forEachChild(node, findScript);
  }
  findConsumer(app);
  findScript(parsed);
  assert.equal(consumers.length, 1);
  assert.equal(scripts.length, 1);
  const consumer = vm.runInContext(`(${consumers[0].getText(app)})`, context);
  const script = scripts[0];
  const declarations = parsed.statements.filter(
    (node) =>
      ts.isFunctionDeclaration(node) &&
      ["installReviewSeedObserver", "reconcileReviewSeedObservation"].includes(node.name.text),
  );
  vm.runInContext(declarations.map((node) => node.getText(parsed)).join("\n"), context);
  const observe = () => vm.runInContext(`(${script.getText(parsed)})()`, context);
  if (observerFirst) observe();
  context.exports.onComposerSeedRequest(consumer);
  if (!observerFirst) observe();
  const calls = [
    { id: 1, sessionId: "owned-a", response: { prompt: "staged A" } },
    { id: 3, sessionId: "owned-a", response: { prompt: "unstaged A" } },
    { id: 5, sessionId: "owned-b", response: { prompt: "staged B" } },
    { id: 4, sessionId: "owned-a", response: { prompt: "staged A" } },
  ];
  vm.runInContext(
    `var [first,currentScope,currentSession,oldSession]=${JSON.stringify(calls)}; var report={};`,
    context,
  );
  context.win = { evaluate: async (callback) => callback() };
  const firstMetric = source.indexOf("  report.rendererSeedObservation =");
  const start = firstMetric < 0 ? source.indexOf("  report.rendererSeedEvents =") : firstMetric;
  const end = source.indexOf("  assert.equal(operations.length, 3);", start);
  assert.ok(start > 0 && end > start);
  return {
    window,
    context,
    drafts,
    activeBucketRef,
    calls,
    publish: (index) =>
      context.exports.requestComposerSeed({
        source: "code-review",
        sessionId: calls[index].sessionId,
        text: calls[index].response.prompt,
      }),
    metrics: () =>
      vm.runInContext(`(async()=>{${source.slice(start, end)};return report;})()`, context),
  };
}

for (const observerFirst of [true, false]) {
  test(`actual source seed metrics distinguish App-rejected late A with observer ${observerFirst ? "before" : "after"} consumer`, async () => {
    const h = actualSeedProtocol(observerFirst);
    assert.equal(h.publish(0), true);
    assert.equal(h.publish(1), true);
    h.activeBucketRef.current = "B";
    const before = { ...h.drafts };
    assert.equal(h.publish(3), false, "actual App bucket guard rejects A while B is active");
    assert.deepEqual(h.drafts, before, "rejected event cannot append to either draft");
    assert.equal(h.publish(2), true);
    await tick();
    const report = await h.metrics();
    assert.equal(report.rendererSeedEvents.length, 3);
    assert.equal(report.rendererSeedAttempts.length, 4);
    assert.deepEqual(
      Array.from(report.rendererSeedAttempts, (row) => row.accepted),
      [true, true, false, true],
    );
  });
}

test("actual seed metrics accept exactly three acknowledgements when no late attempt is dispatched", async () => {
  const h = actualSeedProtocol(true);
  assert.equal(h.publish(0), true);
  assert.equal(h.publish(1), true);
  h.activeBucketRef.current = "B";
  assert.equal(h.publish(2), true);
  await tick();
  const report = await h.metrics();
  assert.equal(report.rendererSeedEvents.length, 3);
  assert.equal(report.rendererSeedAttempts.length, 3);
  assert.equal(report.rendererSeedObservation.pending, 0);
});

test("actual seed metrics fail closed for every other rejection, duplicate or extra acknowledgement", async () => {
  for (const extra of [
    "wrong-text",
    "foreign-session",
    "plugin",
    "duplicate-rejection",
    "extra-acceptance",
  ]) {
    const h = actualSeedProtocol(true);
    h.publish(0);
    h.publish(1);
    if (extra === "extra-acceptance") h.publish(0);
    h.activeBucketRef.current = "B";
    if (extra === "duplicate-rejection") {
      h.publish(3);
      h.publish(3);
    } else if (extra !== "extra-acceptance") {
      h.window.dispatchEvent(
        new globalThis.CustomEvent("codeshell:composer-seed-request", {
          cancelable: true,
          detail:
            extra === "plugin"
              ? { source: "plugin-starter-prompt", text: "extra plugin" }
              : {
                  source: "code-review",
                  sessionId: extra === "foreign-session" ? "foreign" : "owned-a",
                  text: "unexpected",
                },
        }),
      );
    }
    h.publish(2);
    await tick();
    await assert.rejects(h.metrics(), undefined, extra);
    assert.ok(h.window.__ownedReviewSeedObservation.attempts.length >= 4);
  }
});

test("seed acknowledgement remains pending until the dispatch microtask and copies detail synchronously", async () => {
  const tasks = [],
    h = actualSeedProtocol(true, (callback) => tasks.push(callback));
  const detail = { source: "code-review", sessionId: "owned-a", text: "staged A" };
  h.window.dispatchEvent(
    new globalThis.CustomEvent("codeshell:composer-seed-request", { detail, cancelable: true }),
  );
  detail.text = "mutated after dispatch";
  h.publish(1);
  h.activeBucketRef.current = "B";
  h.publish(2);
  const state = h.window.__ownedReviewSeedObservation;
  assert.equal(state.pending, 3);
  assert.equal(state.attempts[0].text, "staged A");
  assert.equal(state.attempts[0].accepted, null);
  await assert.rejects(h.metrics(), /3 !== 0/);
  tasks.splice(0).forEach((callback) => callback());
  const report = await h.metrics();
  assert.equal(report.rendererSeedObservation.pending, 0);
  assert.ok(report.rendererSeedAttempts.every((row) => row.accepted));
});

test("bounded seed observation refuses overflow, invalid events and failed microtask scheduling", async () => {
  const tasks = [],
    h = actualSeedProtocol(true, (callback) => tasks.push(callback));
  for (let i = 0; i < 9; i++) h.publish(0);
  const state = h.window.__ownedReviewSeedObservation;
  assert.equal(state.observed, 9);
  assert.equal(state.attempts.length, 8);
  assert.equal(state.pending, 8);
  assert.equal(state.overflow, true);
  tasks.splice(0).forEach((callback) => callback());
  assert.equal(state.pending, 0);
  await assert.rejects(h.metrics());
  const broken = actualSeedProtocol(true, () => {
    throw Error("owned schedule failure");
  });
  broken.publish(0);
  assert.equal(broken.window.__ownedReviewSeedObservation.pending, 0);
  assert.equal(broken.window.__ownedReviewSeedObservation.failures.length, 1);
  await assert.rejects(broken.metrics());
  for (const event of [
    new globalThis.CustomEvent("codeshell:composer-seed-request", {
      detail: null,
      cancelable: true,
    }),
    new globalThis.CustomEvent("codeshell:composer-seed-request", {
      detail: { source: "code-review", sessionId: "owned-a", text: "staged A" },
    }),
  ]) {
    const invalid = actualSeedProtocol(true);
    invalid.window.dispatchEvent(event);
    await tick();
    assert.equal(invalid.window.__ownedReviewSeedObservation.pending, 0);
    assert.ok(invalid.window.__ownedReviewSeedObservation.failures.length);
    await assert.rejects(invalid.metrics());
  }
});
