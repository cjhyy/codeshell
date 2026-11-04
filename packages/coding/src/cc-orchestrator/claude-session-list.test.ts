import { test, expect } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listRelatedClaudeSessions, createClaudeSessionLister } from "./claude-session-list.js";
import { encodeCwd } from "./session-discovery.js";

test("worker preserves Claude history titles/counts while the host remains responsive", async () => {
  const home = mkdtempSync(join(tmpdir(), "claude-list-worker-"));
  const cwd = join(home, "project");
  const dir = join(home, "projects", encodeCwd(cwd));
  mkdirSync(dir, { recursive: true });
  const user = JSON.stringify({ type: "user", cwd, message: { content: "Fixture request" } });
  const line = JSON.stringify({ type: "assistant", message: { content: "x".repeat(1024) } });
  writeFileSync(join(dir, "session.jsonl"), [user, ...Array(4000).fill(line), user].join("\n"));
  let ticks = 0;
  const timer = setInterval(() => ticks++, 1);
  try {
    const result = await listRelatedClaudeSessions(
      cwd,
      { limit: 20 },
      { claudeHome: home, bindings: [] },
    );
    expect(result.total).toBe(1);
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0]).toMatchObject({
      sessionId: "session",
      cwd,
      firstMessage: "Fixture request",
      messageCount: 2,
    });
    expect(ticks).toBeGreaterThan(0);
    expect(
      await listRelatedClaudeSessions(cwd, {}, { claudeHome: home, bindings: [] }, true),
    ).toEqual(result);
  } finally {
    clearInterval(timer);
    rmSync(home, { recursive: true, force: true });
  }
});

class ControlledWorker extends EventEmitter {
  lifecycle: string[] = [];
  unrefs = 0;
  terminations = 0;
  finishTermination!: (code: number) => void;
  failTermination!: (error: Error) => void;
  private termination = new Promise<number>((resolve, reject) => {
    this.finishTermination = resolve;
    this.failTermination = reject;
  });
  unref() {
    this.lifecycle.push("unref");
    this.unrefs++;
  }
  terminate() {
    this.lifecycle.push("terminate");
    this.terminations++;
    return this.termination;
  }
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const emptyList = { sessions: [], total: 0 };

test("timeout rejects callers without waiting for stuck termination or spawning more workers", async () => {
  const workers: ControlledWorker[] = [];
  const list = createClaudeSessionLister({
    timeoutMs: 10,
    createWorker: () => {
      const worker = new ControlledWorker();
      workers.push(worker);
      return worker;
    },
  });
  const results = await Promise.allSettled([list("/first"), list("/queued")]);
  expect(results).toMatchObject([
    { status: "rejected", reason: { message: "Claude history discovery timed out" } },
    { status: "rejected", reason: { message: "Claude history worker is still shutting down" } },
  ]);
  expect(workers).toHaveLength(1);
  expect(workers[0]!.unrefs).toBe(1);
  expect(workers[0]!.terminations).toBe(1);
  expect(workers[0]!.lifecycle).toEqual(["terminate", "unref"]);
  await expect(list("/later")).rejects.toThrow("still shutting down");
  workers[0]!.finishTermination(1);
  await tick();
  const recovered = list("/recovered");
  await tick();
  expect(workers).toHaveLength(2);
  workers[1]!.emit("message", { ok: true, value: emptyList });
  workers[1]!.finishTermination(0);
  expect(await recovered).toEqual(emptyList);
});

test("successful requests keep the queue serialized until their worker terminates", async () => {
  const workers: ControlledWorker[] = [];
  const list = createClaudeSessionLister({
    createWorker: () => {
      const worker = new ControlledWorker();
      workers.push(worker);
      return worker;
    },
  });
  let completed = false;
  const first = list("/first").then((value) => {
    completed = true;
    return value;
  });
  const second = list("/second");
  await tick();
  workers[0]!.emit("message", { ok: true, value: emptyList });
  await tick();
  expect(completed).toBe(false);
  expect(workers).toHaveLength(1);
  workers[0]!.finishTermination(0);
  expect(await first).toEqual(emptyList);
  await tick();
  expect(workers).toHaveLength(2);
  workers[1]!.emit("message", { ok: true, value: emptyList });
  workers[1]!.finishTermination(0);
  expect(await second).toEqual(emptyList);
});

test("abnormal exit rejects without a reply and releases the queue", async () => {
  const workers: ControlledWorker[] = [];
  const list = createClaudeSessionLister({
    createWorker: () => {
      const worker = new ControlledWorker();
      workers.push(worker);
      return worker;
    },
  });
  const first = list("/first");
  const rejected = first.catch((error) => error);
  await tick();
  workers[0]!.emit("exit", 7);
  expect((await rejected).message).toContain("exited before replying (7)");
  const second = list("/second");
  await tick();
  workers[1]!.emit("message", { ok: true, value: emptyList });
  workers[1]!.finishTermination(0);
  expect(await second).toEqual(emptyList);
  workers[0]!.finishTermination(7);
});

test("failed termination retains the block until an exit confirms the worker is gone", async () => {
  const workers: ControlledWorker[] = [];
  const list = createClaudeSessionLister({
    createWorker: () => {
      const worker = new ControlledWorker();
      workers.push(worker);
      return worker;
    },
  });
  const first = list("/first");
  const rejected = first.catch((error) => error);
  await tick();
  workers[0]!.emit("error", new Error("worker failed"));
  expect((await rejected).message).toBe("worker failed");
  workers[0]!.failTermination(new Error("terminate failed"));
  await tick();
  await expect(list("/blocked")).rejects.toThrow("still shutting down");
  workers[0]!.emit("exit", 1);
  const recovered = list("/recovered");
  await tick();
  workers[1]!.emit("message", { ok: true, value: emptyList });
  workers[1]!.finishTermination(0);
  expect(await recovered).toEqual(emptyList);
});
