import { afterEach, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager, UsageLedger } from "@cjhyy/code-shell-core";
import { ModelTraceStore } from "@cjhyy/code-shell-core/internal";
import {
  ActivityHistoryWorker,
  type ActivityHistoryWorkerRequest,
} from "./activity-history-worker-client.js";

class FakeWorker extends EventEmitter {
  requests: ActivityHistoryWorkerRequest[] = [];
  terminated = false;
  referenced = false;
  postMessage(request: ActivityHistoryWorkerRequest) {
    this.requests.push(request);
  }
  ref() {
    this.referenced = true;
    return this;
  }
  unref() {
    this.referenced = false;
    return this;
  }
  async terminate() {
    this.terminated = true;
    this.emit("exit", 1);
    return 1;
  }
  reply(index: number, error?: string) {
    this.emit("message", { id: this.requests[index]!.id, error });
  }
}

test("history shutdown drains accepted policy writes and maintenance before terminating", async () => {
  const worker = new FakeWorker();
  const history = new ActivityHistoryWorker({ sessionsDir: "/fixture" }, () => worker);
  const writing = history.setConfig({ captureContent: false });
  const closing = history.close();
  expect(worker.requests.map((request) => request.method)).toEqual(["setConfig", "flush"]);
  await expect(history.list()).rejects.toThrow("closed");
  expect(worker.terminated).toBe(false);
  expect(worker.referenced).toBe(true);
  worker.reply(0);
  await writing;
  expect(worker.terminated).toBe(false);
  worker.reply(1);
  await closing;
  expect(worker.terminated).toBe(true);
  expect(history.close()).toBe(closing);
});

test.each(["error", "exit"])(
  "worker %s rejects pending reads and closes cleanly",
  async (event) => {
    const worker = new FakeWorker();
    const history = new ActivityHistoryWorker({ sessionsDir: "/fixture" }, () => worker);
    const reads = [history.usage(), history.sessions()].map((pending) =>
      pending.catch((error) => error),
    );
    worker.emit(event, event === "error" ? new Error("fixture crash") : 7);
    expect((await Promise.all(reads)).every((value) => value instanceof Error)).toBe(true);
    await expect(history.list()).rejects.toThrow(
      event === "error" ? "fixture crash" : "exited (7)",
    );
    await expect(history.close()).rejects.toThrow();
    expect(worker.terminated).toBe(true);
    expect(worker.referenced).toBe(false);
  },
);

test("a rejected query does not poison later reads and queued requests stay bounded", async () => {
  const worker = new FakeWorker();
  const history = new ActivityHistoryWorker({ sessionsDir: "/fixture" }, () => worker);
  const invalid = history.get("../foreign").catch((error) => error);
  worker.reply(0, "Invalid model trace id");
  expect((await invalid).message).toBe("Invalid model trace id");
  const reads = Array.from({ length: 64 }, () => history.getConfig());
  await expect(history.usage()).rejects.toThrow("Too many pending");
  const closing = history.close();
  for (let index = 1; index < worker.requests.length; index++) worker.reply(index);
  await Promise.all(reads);
  await closing;
});

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

test("real history scans leave the caller responsive and retain validation, ownership and policy ordering", async () => {
  const root = mkdtempSync(join(tmpdir(), "codeshell-history-worker-"));
  directories.push(root);
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
  const history = new ActivityHistoryWorker({ sessionsDir: root });
  try {
    await history.getConfig(); // Start the actual worker before measuring the scan.
    let heartbeats = 0;
    const timer = setInterval(() => heartbeats++, 1);
    try {
      const summary = await history.usage({ scope: "session", sessionId: "owned" });
      expect(summary.requests).toBe(1501);
      expect(summary.totalTokens).toBe(1501 * 120);
      expect(summary.partial).toBe(false);
      expect(heartbeats).toBeGreaterThan(0);
    } finally {
      clearInterval(timer);
    }
    expect((await history.list()).items.map((record) => record.id)).toEqual(["request"]);
    expect((await history.sessions()).items[0]?.sessionId).toBe("owned");
    expect((await history.get("request"))?.record.traceId).toBe("run");
    await expect(history.list({ storageDir: "/foreign" })).rejects.toThrow(
      "Unknown model trace query field",
    );
    await expect(history.get("../foreign")).rejects.toThrow("Invalid model trace id");
    await expect(history.usage({ scope: "session", sessionId: "../owned" })).rejects.toThrow();
    const writing = history.setConfig({ captureContent: false, retentionDays: 9 });
    const reading = history.getConfig();
    expect(await writing).toEqual(await reading);
    expect(traces.getConfig()).toMatchObject({ captureContent: false, retentionDays: 9 });
    expect(readFileSync(join(root, "owned", "state.json"), "utf8")).toBe(before);
  } finally {
    await history.close();
  }
});
