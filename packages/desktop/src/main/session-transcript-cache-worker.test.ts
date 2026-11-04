import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import {
  SessionTranscriptCache,
  type TranscriptCacheWorkerRequest,
} from "./session-transcript-cache";

class FakeWorker extends EventEmitter {
  requests: TranscriptCacheWorkerRequest[] = [];
  terminated = false;
  referenced = false;
  postMessage(request: TranscriptCacheWorkerRequest) {
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
const key = { projectKey: "project", sessionId: "session" };

test("shutdown refuses new work and drains accepted writes before terminating", async () => {
  const worker = new FakeWorker();
  const cache = new SessionTranscriptCache({}, () => worker);
  const writing = cache.write({ ...key, value: '{"messages":[]}' });
  const closing = cache.close();
  expect(worker.requests.map((request) => request.method)).toEqual(["write", "flush"]);
  await expect(cache.read(key)).rejects.toThrow("closed");
  expect(worker.terminated).toBe(false);
  expect(worker.referenced).toBe(true);
  worker.reply(0);
  await writing;
  expect(worker.terminated).toBe(false);
  worker.reply(1);
  await closing;
  expect(worker.terminated).toBe(true);
  expect(cache.close()).toBe(closing);
});

test.each(["error", "exit"])(
  "worker %s rejects every pending request and later flush",
  async (event) => {
    const worker = new FakeWorker();
    const cache = new SessionTranscriptCache({}, () => worker);
    const writing = cache.write({ ...key, value: '{"messages":[]}' }).catch((error) => error);
    const reading = cache.read(key).catch((error) => error);
    worker.emit(event, event === "error" ? new Error("fixture crash") : 7);
    expect(await writing).toBeInstanceOf(Error);
    expect(await reading).toBeInstanceOf(Error);
    await expect(cache.flush()).rejects.toThrow(event === "error" ? "fixture crash" : "exited (7)");
    await expect(cache.close()).rejects.toThrow();
    expect(worker.terminated).toBe(true);
    expect(worker.referenced).toBe(false);
  },
);

test("an individual failed write is returned to its caller without poisoning later requests", async () => {
  const worker = new FakeWorker();
  const cache = new SessionTranscriptCache({}, () => worker);
  const failed = cache.write({ ...key, value: "invalid" }).catch((error) => error);
  const flushing = cache.flush();
  worker.reply(0, "invalid JSON");
  worker.reply(1);
  expect((await failed).message).toBe("invalid JSON");
  await flushing;
  const closing = cache.close();
  worker.reply(2);
  await closing;
});
