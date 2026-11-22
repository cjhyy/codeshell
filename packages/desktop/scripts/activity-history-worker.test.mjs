// Real worker-thread suite for the Activity history worker, moved from
// src/main/activity-history-worker.test.ts (assertions unchanged; the client's
// queueing/ref/shutdown contract stays there with a fake worker). See
// main-worker-suite.mjs for why it runs under node --test.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { SessionManager, UsageLedger } from "@cjhyy/code-shell-core";
import { RoomManager } from "@cjhyy/code-shell-server/mobile-remote";
import { ModelTraceStore } from "@cjhyy/code-shell-core/internal";
import { compileMainModules } from "./main-worker-suite.mjs";

const cleanup = [];
const workers = [];
after(async () => {
  // A failed assertion must not leave a worker thread keeping Node alive.
  await Promise.all(workers.splice(0).map((worker) => worker.terminate()));
  for (const remove of cleanup.splice(0)) remove();
});

test("real history scans leave the caller responsive and retain validation, ownership and policy ordering", async () => {
  const compiled = await compileMainModules([
    "activity-history-worker-client",
    "activity-history-worker",
  ]);
  cleanup.push(compiled.remove);
  const { ActivityHistoryWorker, createActivityHistoryWorker } = compiled.module;
  const root = mkdtempSync(join(tmpdir(), "codeshell-history-worker-"));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const sessions = new SessionManager(root);
  sessions.create("/workspace", "gpt-4o", "openai", "owned");
  const ledger = new UsageLedger({ storageDir: join(root, ".usage-ledger") });
  const owner = ledger.owner("owned", "run", [], "main", root);
  const reference = ledger.sessionState("owned", root);
  sessions.updateSessionState("owned", { costState: reference });
  const receipt = ledger.begin(owner, { provider: "openai", model: "gpt-4o" });
  ledger.settle(receipt, { promptTokens: 100, completionTokens: 20, totalTokens: 120 });
  ledger.finish(receipt, "completed");
  const namespace = createHash("sha256").update("default").digest("hex");
  for (let index = 0; index < 1500; index++) {
    const requestId = createHash("sha256").update(`fixture-${index}`).digest("hex");
    writeFileSync(
      join(root, ".usage-ledger", namespace, `${requestId}.json`),
      JSON.stringify({ ...receipt, requestId }),
    );
  }
  const traces = new ModelTraceStore({ storageDir: join(root, ".model-traces") });
  traces.write({
    version: 1,
    id: "request",
    traceId: "run",
    sessionId: "owned",
    source: "fixture",
    purpose: "main",
    provider: "openai",
    model: "gpt-4o",
    startedAt: Date.now(),
    status: "completed",
    stream: false,
    inputState: "not-recorded",
    outputState: "not-recorded",
    attempts: [],
  });
  await traces.flushMaintenance();
  const before = readFileSync(join(root, "owned", "state.json"), "utf8");
  const roomsDir = join(root, "rooms");
  const manager = new RoomManager({
    rootDir: roomsDir,
    createAgent() {
      throw Error("History reads must never start a CLI");
    },
    onMessage() {},
  });
  const room = manager.createRoom({ cwd: root });
  const history = new ActivityHistoryWorker({ sessionsDir: root, roomsDir }, (options) => {
    const worker = createActivityHistoryWorker(options);
    workers.push(worker);
    worker.once("exit", () => workers.splice(workers.indexOf(worker), 1));
    return worker;
  });
  try {
    await history.getConfig(); // Start the actual worker before measuring the scan.
    const roomInput = { rootIdentity: manager.rootIdentity, roomId: room.id };
    const page = await history.roomHistory("rooms/historyPage", {
      ...roomInput,
      request: { limit: 1 },
    });
    assert.equal(page.messages[0].type, "room_created");
    assert.deepEqual(
      await history.roomHistory("rooms/messages", { ...roomInput, sinceSeq: 0 }),
      page.messages,
    );
    await assert.rejects(
      history.roomHistory("rooms/messages", {
        ...roomInput,
        rootIdentity: "different-room-root",
        sinceSeq: 0,
      }),
      /root changed/,
    );
    let heartbeats = 0;
    const timer = setInterval(() => heartbeats++, 1);
    try {
      const summary = await history.usage({ scope: "session", sessionId: "owned" });
      assert.equal(summary.requests, 1501);
      assert.equal(summary.totalTokens, 1501 * 120);
      assert.equal(summary.partial, false);
      assert.ok(heartbeats > 0, "the caller's event loop kept running during the scan");
    } finally {
      clearInterval(timer);
    }
    assert.deepEqual(
      (await history.list()).items.map((record) => record.id),
      ["request"],
    );
    assert.equal((await history.sessions()).items[0]?.sessionId, "owned");
    assert.equal((await history.get("request"))?.record.traceId, "run");
    await assert.rejects(history.list({ storageDir: "/foreign" }), (error) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /Unknown model trace query field/);
      return true;
    });
    await assert.rejects(history.get("../foreign"), (error) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /Invalid model trace id/);
      return true;
    });
    await assert.rejects(history.usage({ scope: "session", sessionId: "../owned" }), Error);
    const writing = history.setConfig({ captureContent: false, retentionDays: 9 });
    const reading = history.getConfig();
    assert.deepEqual(await writing, await reading);
    assert.deepEqual(
      {
        captureContent: traces.getConfig().captureContent,
        retentionDays: traces.getConfig().retentionDays,
      },
      { captureContent: false, retentionDays: 9 },
    );
    assert.equal(readFileSync(join(root, "owned", "state.json"), "utf8"), before);
  } finally {
    await history.close();
  }
});
