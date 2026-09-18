import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkerBridgeCore } from "@cjhyy/code-shell-server/worker";
import { PetDispatchService } from "./pet-dispatch-service";

// Real stdio transport and child exits; only the model worker's behavior is
// scripted. The dispatcher's options must propagate through to correlation.
const workerScript = `
if (process.env.MIMI_LIFECYCLE_MODE === "startup-failure") {
  console.error("No configured text model");
  process.exit(1);
}
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk.toString();
  let newline;
  while ((newline = buffer.indexOf("\\n")) >= 0) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (!line.trim()) continue;
    const request = JSON.parse(line);
    if (process.env.MIMI_LIFECYCLE_MODE === "healthy") {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id,
        result: { text: "Recovered reply", reason: "completed" } }) + "\\n");
    } else if (process.env.MIMI_LIFECYCLE_MODE === "accepted-steer" && request.method === "agent/steer") {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id,
        result: { accepted: true } }) + "\\n");
      setTimeout(() => process.exit(1), 20);
    } else if (request.method === "agent/run") {
      process.stdout.write(JSON.stringify({ method: "test/runStarted" }) + "\\n");
    } else if (request.method === process.env.MIMI_LIFECYCLE_MODE) {
      process.exit(1);
    }
  }
});
`;

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function makeHarness(initialMode: string) {
  const dir = mkdtempSync(join(tmpdir(), "mimi-worker-lifecycle-"));
  const entryPath = join(dir, "worker.cjs");
  writeFileSync(entryPath, workerScript);
  let mode = initialMode;
  let resolveStarted!: () => void;
  const runStarted = new Promise<void>((resolve) => {
    resolveStarted = resolve;
  });
  const outcomes: Array<{ method: string; status: string }> = [];
  const core = new WorkerBridgeCore({
    entryPath,
    fallbackCwd: () => dir,
    buildEnv: () => ({ ...process.env, MIMI_LIFECYCLE_MODE: mode }),
    onExit: () => {
      mode = "healthy";
    },
  });
  core.subscribeLines((line) => {
    if (JSON.parse(line).method === "test/runStarted") resolveStarted();
  });
  cleanups.push(() => {
    core.kill();
    rmSync(dir, { recursive: true, force: true });
  });
  let requestId = 0;
  const service = new PetDispatchService({
    hostCwd: dir,
    metadata: { ensure: async () => ({ petSessionId: "pet-lifecycle" }) },
    aggregator: {
      getSnapshot: () => ({
        version: 1,
        generation: 1,
        workerState: "active",
        observedAt: Date.now(),
        sessions: [],
        pending: [],
        workMemorySegments: [],
      }),
      resolveNavigation: async () => ({ status: "not-found" }),
    },
    worker: {
      requestWorker: async (method, params, options) => {
        const outcome = await core.request(method, params, {
          ...options,
          id: ++requestId,
          // A short backstop keeps a regression from waiting the production
          // 120 seconds. Every assertion requires exit/send-failure, not timeout.
          timeoutMs: 1_000,
          ensureWorker: method === "agent/run",
          ensureWorkerCwd: dir,
        });
        outcomes.push({ method, status: outcome.status });
        return outcome.status === "result"
          ? { ok: true, result: outcome.result }
          : { ok: false, message: outcome.status };
      },
    },
  });
  return { service, runStarted, outcomes };
}

describe("Mimi real worker lifecycle", () => {
  test("startup failure settles the input on exit and a subsequent input recovers", async () => {
    const { service, outcomes } = makeHarness("startup-failure");
    expect(
      await service.dispatch({ type: "chat", message: "First input", clientMessageId: "first" }),
    ).toEqual({ ok: false, code: "worker-error", message: "workerExit" });
    expect(
      await service.dispatch({ type: "chat", message: "Try again", clientMessageId: "second" }),
    ).toMatchObject({ ok: true, result: { text: "Recovered reply", reason: "completed" } });
    expect(outcomes.map(({ status }) => status)).toEqual(["workerExit", "result"]);
  });

  test("worker exit during stop settles both requests and releases the chat", async () => {
    const { service, runStarted, outcomes } = makeHarness("agent/cancel");
    const chat = service.dispatch({ type: "chat", message: "Wait", clientMessageId: "first" });
    await runStarted;
    const stop = service.dispatch({ type: "stop_chat", clientMessageId: "first" });
    expect(await stop).toEqual({ ok: false, code: "worker-error", message: "workerExit" });
    expect(await chat).toEqual({ ok: false, code: "worker-error", message: "workerExit" });
    expect(await service.dispatch({ type: "stop_chat", clientMessageId: "first" })).toEqual({
      ok: true,
      type: "chat_stopped",
      stopped: false,
    });
    expect(outcomes).toEqual([
      { method: "agent/run", status: "workerExit" },
      { method: "agent/cancel", status: "workerExit" },
    ]);
  });

  test("worker exit during steer releases the queued input to a fresh worker", async () => {
    const { service, runStarted, outcomes } = makeHarness("agent/steer");
    const first = service.dispatch({ type: "chat", message: "Wait", clientMessageId: "first" });
    await runStarted;
    const second = service.dispatch({
      type: "chat",
      message: "Follow up",
      clientMessageId: "second",
    });
    expect(await first).toEqual({ ok: false, code: "worker-error", message: "workerExit" });
    expect(await second).toMatchObject({
      ok: true,
      result: { text: "Recovered reply", reason: "completed" },
    });
    expect(outcomes).toEqual([
      { method: "agent/run", status: "workerExit" },
      { method: "agent/steer", status: "workerExit" },
      { method: "agent/run", status: "result" },
    ]);
  });

  test("accepted steer cleanup fails fast after exit so the next input is not blocked", async () => {
    const { service, runStarted, outcomes } = makeHarness("accepted-steer");
    const first = service.dispatch({ type: "chat", message: "Wait", clientMessageId: "first" });
    await runStarted;
    const second = service.dispatch({
      type: "chat",
      message: "Follow up",
      clientMessageId: "second",
    });
    expect(await first).toEqual({ ok: false, code: "worker-error", message: "workerExit" });
    expect(await second).toMatchObject({
      ok: true,
      result: { text: "Recovered reply", reason: "completed" },
    });
    expect(outcomes).toEqual([
      { method: "agent/steer", status: "result" },
      { method: "agent/run", status: "workerExit" },
      { method: "agent/unsteer", status: "sendFailed" },
      { method: "agent/run", status: "result" },
    ]);
  });

  test("an internal report releases its reservation when worker startup fails", async () => {
    const { service, outcomes } = makeHarness("startup-failure");
    await expect(
      service.reportSessionMessage({
        reportId: "a".repeat(32),
        sourceSessionId: "work-session",
        message: "The work finished",
      }),
    ).rejects.toThrow("workerExit");
    expect(
      await service.dispatch({ type: "chat", message: "New input", clientMessageId: "new" }),
    ).toMatchObject({ ok: true, result: { text: "Recovered reply", reason: "completed" } });
    expect(outcomes.map(({ status }) => status)).toEqual(["workerExit", "result"]);
  });
});
