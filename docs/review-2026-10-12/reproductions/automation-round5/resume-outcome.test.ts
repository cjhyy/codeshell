import { fileURLToPath } from "node:url";
import { test, expect } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";

const repo = fileURLToPath(new URL("../../../../", import.meta.url));
const isolation = await import(repo + "/scripts/runtime-cost-smoke-isolation.mjs");
// No fixture needs a network request. The sole permitted origin has no listener.
// Install before any production Host/Core import; no real provider is reachable.
isolation.installLocalNetworkGuard("http://127.0.0.1:9");
const { CronScheduler } = await import(repo + "/packages/core/src/automation/scheduler.ts");
const { bindCronToEngine } = await import(repo + "/packages/core/src/automation/runner.ts");
const { makeCronRunnerWithResume } = await import(repo + "/packages/desktop/src/main/automation-host.ts");
const { injectAndAwaitResult } = await import(repo + "/packages/desktop/src/main/mobile-remote/handle-client-event.ts");
const { automationLifecycleNotification } = await import(repo + "/packages/desktop/src/main/automation-notification.ts");
const { ChatSession } = await import(repo + "/packages/core/src/protocol/chat-session.ts");

// Load the actual production closure without starting Electron/Main. No branches
// are reimplemented: its external dependencies are supplied as function arguments.
const mainSource = readFileSync(repo + "/packages/desktop/src/main/index.ts", "utf8");
const closureStart = mainSource.indexOf("    const injectResumeTurn = async (");
const closureEnd = mainSource.indexOf("    const automationRunner = makeCronRunnerWithResume(", closureStart);
expect(closureStart).toBeGreaterThan(0);
expect(closureEnd).toBeGreaterThan(closureStart);
const closureSource = mainSource.slice(closureStart, closureEnd);
const compiled = new Bun.Transpiler({ loader: "ts" }).transformSync(closureSource + "\nreturn injectResumeTurn;\n");
const makeInjector = (bridge: unknown, awaitResult = injectAndAwaitResult) =>
  new Function("bridge", "injectAndAwaitResult", "ErrorCodes", "desktopNotifications", "desktopNotifier", compiled)(
    bridge,
    awaitResult,
    { SessionNotFound: -32002 },
    { notifyMissingAutomationResumeTarget: async () => {} },
    null,
  );

function fixtureBridge(reply?: (frame: any) => any) {
  const observers = new Set<(line: string) => void>();
  const frames: any[] = [];
  const bridge = {
    subscribeOutbound(listener: (line: string) => void) {
      observers.add(listener);
      return () => observers.delete(listener);
    },
    injectWorkerMessage(line: string) {
      const frame = JSON.parse(line);
      frames.push(frame);
      const response = reply?.(frame);
      if (response) for (const listener of observers) listener(JSON.stringify(response));
    },
    emit(frame: any) {
      for (const listener of observers) listener(JSON.stringify(frame));
    },
  };
  return { bridge, frames };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
function setup(injector: any) {
  const scheduler = new CronScheduler();
  scheduler.setExecutionEnabled(false);
  const events: any[] = [];
  scheduler.setJobEventListener((event) => events.push(event));
  bindCronToEngine(scheduler, makeCronRunnerWithResume(
    async () => { throw Error("the headless path must remain unused"); },
    injector,
    async () => ({ ok: true, authority: { cwd: "/fixture", projectId: "p", rootId: "r" } }),
  ));
  const job = scheduler.create("续接任务", "1h", "本地 fixture，无真实模型", {
    cwd: "/fixture", projectId: "p", rootId: "r", resumeSessionId: "s-fixture",
  });
  return { scheduler, events, job };
}

test("a rejected production resume injection is reported as completed", async () => {
  const { bridge, frames } = fixtureBridge((frame) => ({
    jsonrpc: "2.0", id: frame.id, error: { code: -32603, message: "fixture worker failed to initialize model" },
  }));
  const { scheduler, events, job } = setup(makeInjector(bridge));
  expect(scheduler.runNow(job.id)).toBe(true);
  await tick();
  expect(frames).toHaveLength(1);
  expect(events.map((event) => event.type)).toEqual(["job_start", "job_end"]);
  const notification = automationLifecycleNotification(events[1]);
  expect(notification?.type).toBe("automation.completed");
  expect(notification?.text).not.toContain("failed to initialize");
  writeFileSync(new URL("./resume-rejected-observed.json", import.meta.url), JSON.stringify({
    frames,
    events: events.map(({ type, error, reason }) => ({ type, error, reason })),
    notification,
  }, null, 2));
  scheduler.stopAll();
});

test("accepted but long resume run times out, reports completed and admits another dispatch", async () => {
  let finishFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => { finishFirst = resolve; });
  const executed: string[] = [];
  const chat = new ChatSession({ id: "s-fixture", engine: {
    async run(task: string) {
      executed.push(task);
      if (executed.length === 1) await firstGate;
      return { text: "fixture", reason: "completed", sessionId: "s-fixture" };
    },
  } as any });
  const fixture = fixtureBridge((frame) => {
    void chat.enqueueTurn(frame.params.task, {}).then((result) => fixture.bridge.emit({
      jsonrpc: "2.0", id: frame.id, result,
    }));
    return {
      jsonrpc: "2.0", method: "agent/runAccepted", params: { requestId: frame.id, sessionId: "s-fixture" },
    };
  });
  const { bridge, frames } = fixture;
  // Compress only the helper's 120s waiting interval to 20ms. Production does
  // not clear this timer on runAccepted; bridge never sends the final response.
  const shortened = (b: any, method: string, params: any, meta: any) =>
    injectAndAwaitResult(b, method, params, meta, 20);
  const { scheduler, events, job } = setup(makeInjector(bridge, shortened));
  scheduler.runNow(job.id);
  await new Promise((resolve) => setTimeout(resolve, 35));
  expect(events.map((event) => event.type)).toEqual(["job_start", "job_end"]);
  expect(frames).toHaveLength(1);
  scheduler.runNow(job.id);
  await new Promise((resolve) => setTimeout(resolve, 35));
  expect(frames.map((frame) => frame.method)).toEqual(["agent/run", "agent/run"]);
  expect(events.map((event) => event.type)).toEqual(["job_start", "job_end", "job_start", "job_end"]);
  expect(job.runCount).toBe(2);
  expect(chat.isBusy()).toBe(true);
  expect(chat.queueDepth()).toBe(1);
  expect(executed).toHaveLength(1);
  const queuedBeforeFirstCompletes = chat.queueDepth();
  finishFirst();
  await tick();
  expect(executed).toEqual([job.prompt, job.prompt]);
  expect(chat.isBusy()).toBe(false);
  writeFileSync(new URL("./resume-timeout-observed.json", import.meta.url), JSON.stringify({
    timerCompression: "120000ms → 20ms; accepted run never receives a terminal result",
    frames,
    events: events.map(({ type, error, reason }) => ({ type, error, reason })),
    runCount: job.runCount,
    queuedBeforeFirstCompletes,
    executedAfterRelease: executed,
  }, null, 2));
  scheduler.stopAll();
});

test("scheduler abort does not send a cancel frame for the production resume injector", async () => {
  const { bridge, frames } = fixtureBridge();
  const { scheduler, events, job } = setup(makeInjector(bridge));
  scheduler.runNow(job.id);
  await tick();
  let settled = false;
  const abort = scheduler.abort(job.id).then(() => { settled = true; });
  await tick();
  expect(settled).toBe(false);
  expect(frames.map((frame) => frame.method)).toEqual(["agent/run"]);
  // Finish our fake worker to cleanly settle the test; no external process exists.
  bridge.emit({ jsonrpc: "2.0", id: frames[0].id, result: { text: "fixture", reason: "completed" } });
  await abort;
  expect(events.map((event) => event.type)).toEqual(["job_start", "job_cancelled"]);
  writeFileSync(new URL("./resume-abort-observed.json", import.meta.url), JSON.stringify({
    cancelSettledBeforeWorkerResult: false,
    frames,
    events: events.map(({ type, error, reason }) => ({ type, error, reason })),
  }, null, 2));
  scheduler.stopAll();
});
