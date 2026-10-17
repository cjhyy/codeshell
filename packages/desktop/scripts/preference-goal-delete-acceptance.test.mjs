import assert from "node:assert/strict";
import { test, after } from "node:test";
import { runInNewContext } from "node:vm";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import children from "node:child_process";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";

// No Core/Electron/Playwright import or actual subprocess/query/signal/network.
// Install denials before the helper import; there are no negative-probe calls.
const attempts = [],
  originals = [];
for (const [owner, key] of [
  [children, "spawn"],
  [children, "spawnSync"],
  [children, "execFile"],
  [children, "execFileSync"],
  [children, "exec"],
  [children, "execSync"],
  [children, "fork"],
  [process, "kill"],
  [http, "request"],
  [http, "get"],
  [https, "request"],
  [https, "get"],
  [net, "connect"],
  [net, "createConnection"],
  [tls, "connect"],
  [globalThis, "fetch"],
]) {
  originals.push([owner, key, owner[key]]);
  owner[key] = () => {
    attempts.push(key);
    throw new Error("Pure Goal contract denied OS/network");
  };
}
const { preferenceGoalDeleteGuardSource, reconcilePreferenceGoalLedger } =
  await import("./preference-goal-delete-acceptance.mjs");
after(() => {
  for (const [owner, key, value] of originals) owner[key] = value;
  assert.deepEqual(attempts, []);
});

const config = {
  sessionIds: ["owned-a", "owned-b"],
  goalId: "owned-goal",
  revision: 7,
  ledger: "/owned/private/goal-rpc.jsonl",
};
const frame = (method, params, id = "rpc-1") =>
  JSON.stringify({ jsonrpc: "2.0", id, method, params });
const deletion = (id = "delete-1", changes = {}) =>
  frame(
    "agent/goalDelete",
    {
      sessionId: "owned-a",
      expectedGoalId: "owned-goal",
      expectedRevision: 7,
      ...changes,
    },
    id,
  );
function fixture({ handler, brokenSink = false } = {}) {
  const registered = new Map(),
    durable = [],
    sent = [],
    invocations = [];
  const state = {};
  const ipcMain = {
    on(channel, listener) {
      registered.set(channel, listener);
      return ipcMain;
    },
  };
  const event = {
    sender: {
      send(...args) {
        sent.push(args);
        return "original-send-result";
      },
    },
  };
  const send = event.sender.send;
  runInNewContext(
    preferenceGoalDeleteGuardSource(config),
    {
      ipcMain,
      state,
      Buffer,
      appendFileSync(path, line, options) {
        assert.equal(path, config.ledger);
        assert.equal(options.mode, 0o600);
        if (brokenSink) throw new Error("owned sink failed");
        durable.push(JSON.parse(line));
      },
      attempt(kind) {
        assert.equal(kind, "goal-rpc");
      },
    },
    { timeout: 1000 },
  );
  const receiver = { actual: "original receiver" };
  const original =
    handler ??
    function (event, line) {
      const request = JSON.parse(line);
      invocations.push({ receiver: this, event, line });
      const result =
        request.method === "agent/goalDelete"
          ? { ok: true, deleted: true }
          : request.method === "agent/backgroundWork"
            ? { items: [] }
            : request.method === "agent/backgroundShells"
              ? { shells: [] }
              : { ok: true, goal: null, paused: false };
      event.sender.send("agent:msg", JSON.stringify({ jsonrpc: "2.0", id: request.id, result }));
      return receiver;
    };
  ipcMain.on("agent:msg", original);
  return {
    state,
    durable,
    sent,
    invocations,
    event,
    send,
    receiver,
    invoke(line) {
      return registered.get("agent:msg").call(receiver, event, line);
    },
    arm() {
      state.goalDelete.armed = true;
    },
  };
}

test("actual generated guard delegates exact frame/receiver and observes the unchanged reply", () => {
  const f = fixture();
  f.arm();
  const input =
    '{"jsonrpc":"2.0","id":"delete-1","method":"agent/goalDelete","params":{"sessionId":"owned-a","expectedGoalId":"owned-goal","expectedRevision":7}}';
  assert.equal(f.invoke(input), f.receiver);
  assert.equal(f.invocations.length, 1);
  assert.equal(f.invocations[0].line, input);
  assert.equal(f.invocations[0].event, f.event);
  assert.equal(f.invocations[0].receiver, f.receiver);
  assert.equal(f.event.sender.send, f.send);
  assert.equal(f.state.goalDelete.pending, 0);
  assert.equal(
    f.sent[0][1],
    '{"jsonrpc":"2.0","id":"delete-1","result":{"ok":true,"deleted":true}}',
  );
  const result = reconcilePreferenceGoalLedger(config, [], f.durable);
  assert.equal(result.deletion.response.result.deleted, true);
  assert.equal(result.lateRows, 2);
});

test("ordinary readonly UI remains original before arming; armed reads are two-session confined", () => {
  const f = fixture();
  f.invoke(frame("agent/goalGet", { sessionId: "ordinary-existing-ui" }));
  assert.equal(f.invocations.length, 1);
  assert.equal(f.durable.length, 0);
  f.arm();
  for (const [method, params] of [
    ["agent/goalGet", { sessionId: "owned-b" }],
    ["agent/backgroundWork", { sessionId: "owned-a", scope: "session" }],
    ["agent/backgroundShells", { sessionId: "owned-b", action: "list" }],
  ])
    f.invoke(frame(method, params, "read-" + f.durable.length));
  f.invoke(deletion());
  assert.equal(reconcilePreferenceGoalLedger(config, [], f.durable).requests.length, 4);
  assert.throws(() => f.invoke(frame("agent/goalGet", { sessionId: "foreign" }, "foreign-read")));
});

test("unreviewed mutations, foreign IDs, stale versions and extra arguments never reach a listener", () => {
  const invalid = [
    ...[
      "run",
      "configure",
      "forkSession",
      "query",
      "goalUpdate",
      "goalExtend",
      "goalClear",
      "resume",
    ].map((method) => frame("agent/" + method, { sessionId: "owned-a" })),
    deletion("x", { sessionId: "owned-b" }),
    deletion("x", { expectedGoalId: "other" }),
    deletion("x", { expectedRevision: 6 }),
    deletion("x", { extra: true }),
    "[]",
    frame("agent/goalGet", { sessionId: "../foreign" }),
    deletion() + "\n",
  ];
  for (const input of invalid) {
    const f = fixture();
    f.arm();
    assert.throws(() => f.invoke(input));
    assert.equal(f.invocations.length, 0);
    assert.ok(f.state.goalDelete.failures.length);
    assert.equal(f.event.sender.send, f.send);
  }
  const unarmed = fixture();
  assert.throws(() => unarmed.invoke(deletion()));
  assert.equal(unarmed.invocations.length, 0);
});

test("duplicate deletions/request IDs and finite ledger overflow latch failure", () => {
  const duplicate = fixture();
  duplicate.arm();
  duplicate.invoke(deletion());
  assert.throws(() => duplicate.invoke(deletion("another")));
  assert.equal(duplicate.invocations.length, 1);
  const reused = fixture();
  reused.arm();
  reused.invoke(frame("agent/goalGet", { sessionId: "owned-a" }));
  assert.throws(() => reused.invoke(frame("agent/goalGet", { sessionId: "owned-a" })));
  const capped = fixture();
  capped.arm();
  for (let i = 0; i < 128; i++)
    capped.invoke(frame("agent/goalGet", { sessionId: "owned-a" }, "read-" + i));
  assert.throws(() => capped.invoke(frame("agent/goalGet", { sessionId: "owned-a" }, "extra")));
  assert.equal(capped.durable.length, 256);
  assert.ok(capped.state.goalDelete.failures.length);
});

test("original rejection and diagnostic IO failure cannot fabricate success or retain a sender wrapper", () => {
  const originalError = new Error("production listener rejected");
  const rejected = fixture({
    handler() {
      throw originalError;
    },
  });
  rejected.arm();
  assert.throws(
    () => rejected.invoke(deletion()),
    (error) => error === originalError,
  );
  assert.equal(rejected.event.sender.send, rejected.send);
  assert.equal(rejected.state.goalDelete.pending, 0);
  assert.ok(rejected.state.goalDelete.failures.length);
  assert.throws(() => reconcilePreferenceGoalLedger(config, [], rejected.durable));
  const broken = fixture({ brokenSink: true });
  broken.arm();
  assert.throws(() => broken.invoke(deletion()), /owned sink failed/);
  assert.equal(broken.invocations.length, 0);
  assert.ok(broken.state.goalDelete.failures.length);
});

test("final sequence accepts legal late reads but rejects snapshots, errors and missing/false deletion", () => {
  const f = fixture();
  f.arm();
  f.invoke(deletion());
  const snapshot = JSON.parse(JSON.stringify(f.durable));
  f.invoke(frame("agent/goalGet", { sessionId: "owned-a" }, "late"));
  assert.equal(reconcilePreferenceGoalLedger(config, snapshot, f.durable).lateRows, 2);
  const copy = () => JSON.parse(JSON.stringify(f.durable));
  const bad = copy();
  bad[0].request.params.expectedRevision = 6;
  assert.throws(() => reconcilePreferenceGoalLedger(config, [], bad));
  const failed = copy();
  failed[1].response.result.deleted = false;
  assert.throws(() => reconcilePreferenceGoalLedger(config, [], failed));
  assert.throws(() => reconcilePreferenceGoalLedger(config, [{ kind: "foreign" }], f.durable));
  assert.throws(() => reconcilePreferenceGoalLedger(config, [], []));
});

test("driver keeps the six original operation bodies/three launches and requires new acceptance for HOME deletion", () => {
  const source = readFileSync(
    new URL("./e2e-preferences-operation-cycles.mjs", import.meta.url),
    "utf8",
  ).replace(/\r\n/g, "\n");
  const start = source.indexOf('  await operation(\n    "General English selection');
  const marker = "  assert.equal(operations.length, 6);\n";
  const end = source.indexOf(marker, start) + marker.length;
  assert.ok(start >= 0 && end > start);
  assert.equal(
    createHash("sha256").update(source.slice(start, end)).digest("hex"),
    "4ce5473ab5aa847c8c37beae6e5847c092b345ddb8e8ebfaedf4709b9dc03f46",
  );
  assert.equal((source.match(/ {2}await launch\(\);/g) || []).length, 3);
  assert.ok(source.includes('receipt.goalDeleteAcceptance.status === "passed" &&'));
  assert.ok(
    source.includes("    await deletePausedGoal();") ||
      source.includes("  await deletePausedGoal();"),
  );
  assert.ok(source.includes("timeoutMs: 180_000"));
  assert.ok(source.includes("assert.deepEqual(resource.proof.exit, { code: 0, signal: null })"));
});
