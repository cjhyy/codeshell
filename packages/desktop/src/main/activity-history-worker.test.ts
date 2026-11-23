// The real worker thread's end-to-end suite runs under node --test in
// packages/desktop/scripts/activity-history-worker.test.mjs.
import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
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
  ready() {
    this.emit("message", { type: "ready" });
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
  expect(worker.requests).toHaveLength(0);
  worker.ready();
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
  worker.ready();
  worker.reply(0, "Invalid model trace id");
  expect((await invalid).message).toBe("Invalid model trace id");
  const reads = Array.from({ length: 64 }, () => history.getConfig());
  await expect(history.usage()).rejects.toThrow("Too many pending");
  const closing = history.close();
  for (let index = 1; index < worker.requests.length; index++) worker.reply(index);
  await Promise.all(reads);
  await closing;
});

test("a cold quit cancels unstarted dashboard reads without waiting for imports", async () => {
  const worker = new FakeWorker();
  const history = new ActivityHistoryWorker({ sessionsDir: "/fixture" }, () => worker);
  const reads = [
    history.mimiExternalActivity({}),
    history.view("activity/runs", {}),
    history.view("profiles/list", { target: null }),
  ].map((read) => read.catch((error) => error));
  const closing = history.close();
  await closing;
  expect(worker.terminated).toBe(true);
  expect(
    (await Promise.all(reads)).every(
      (error) => error instanceof Error && /closed/.test(error.message),
    ),
  ).toBe(true);
  worker.ready();
  expect(worker.requests).toEqual([]);
});

test("a cold quit preserves FIFO when an accepted write follows a dashboard read", async () => {
  const worker = new FakeWorker();
  const history = new ActivityHistoryWorker({ sessionsDir: "/fixture" }, () => worker);
  const read = history.mimiExternalActivity({});
  const title = { id: "owned", title: "saved" };
  const write = history.setTitle(title, new Int32Array(new SharedArrayBuffer(4)));
  title.title = "changed after admission";
  const closing = history.close();
  worker.ready();
  expect(worker.requests.map(({ method }) => method)).toEqual([
    "mimiExternalActivity",
    "activity/setTitle",
    "flush",
  ]);
  worker.reply(0);
  expect(worker.requests[1]?.input).toEqual({ id: "owned", title: "saved" });
  worker.reply(1);
  await Promise.all([read, write]);
  expect(worker.terminated).toBe(false);
  worker.reply(2);
  await closing;
  expect(worker.terminated).toBe(true);
});
