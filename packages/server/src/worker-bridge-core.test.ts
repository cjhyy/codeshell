// packages/server/src/worker-bridge-core.test.ts
//
// WorkerBridgeCore is the transport-agnostic half of the agent bridge (zero
// electron imports), so it is directly testable under bun with a real child
// process: a tiny echo worker script stands in for agent-server-stdio.
//
// Covered here: stdout line framing + listener dispatch, request/response
// correlation (consume vs pass-through, timeout, settle-on-exit, fail-fast
// when no worker), correlated/injected prepareInbound rewriting + drop
// semantics, and lifecycle callbacks (started generation / clean exit).
import { describe, test, expect, beforeAll, afterAll, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  WorkerBridgeCore,
  previewLine,
  type WorkerExitInfo,
  type WorkerFrameMeta,
} from "./worker-bridge-core.js";

const TEST_META: WorkerFrameMeta = { origin: "host", producer: "worker-bridge-test" };

// Echo worker: line-delimited JSON-RPC on stdio.
//   - on boot, emits a `test/hello` notification
//   - requests (with id) are answered {id, result:{method, echo: params ?? null}}
//     (method "test/error" answers an error; "test/never" never answers)
//   - notifications are mirrored back as {method:"test/received", params:{line}}
//   - method "test/duplicate" answers twice with the same id
//   - method "test/exit" exits 0
const WORKER_SCRIPT = `
let buf = "";
process.stdin.on("data", (chunk) => {
  buf += chunk.toString();
  let idx;
  while ((idx = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, idx);
    buf = buf.slice(idx + 1);
    if (!line.trim()) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.method === "test/exit") process.exit(0);
    if (msg.method === "test/never") continue;
    if (msg.method === "test/duplicate") {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { sequence: 1 } }) + "\\n");
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { sequence: 2 } }) + "\\n");
      continue;
    }
    if (msg.id !== undefined) {
      const reply = msg.method === "test/error"
        ? { jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: "boom" } }
        : { jsonrpc: "2.0", id: msg.id, result: { method: msg.method, echo: msg.params ?? null } };
      process.stdout.write(JSON.stringify(reply) + "\\n");
    } else {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", method: "test/received", params: { line } }) + "\\n");
    }
  }
});
process.stdout.write(JSON.stringify({ jsonrpc: "2.0", method: "test/hello" }) + "\\n");
`;

let dir: string;
let entryPath: string;
const cores: WorkerBridgeCore[] = [];

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "worker-bridge-core-"));
  entryPath = join(dir, "echo-worker.cjs");
  writeFileSync(entryPath, WORKER_SCRIPT);
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

afterEach(() => {
  for (const core of cores.splice(0)) core.kill();
});

function makeCore(
  opts: Partial<ConstructorParameters<typeof WorkerBridgeCore>[0]> = {},
): WorkerBridgeCore {
  const core = new WorkerBridgeCore({ entryPath, fallbackCwd: () => dir, ...opts });
  cores.push(core);
  return core;
}

function pendingRequestCount(core: WorkerBridgeCore): number {
  return (
    core as unknown as {
      pendingRequests: Map<string | number, unknown>;
    }
  ).pendingRequests.size;
}

/** Wait until the worker's boot notification arrives (worker is live). */
function waitForHello(core: WorkerBridgeCore, cwd?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("worker never said hello")), 10_000);
    const unsubscribe = core.subscribeLines((line) => {
      if (line.includes("test/hello")) {
        clearTimeout(timer);
        unsubscribe();
        resolve();
      }
    });
    core.ensureWorker(cwd);
  });
}

function waitForLine(core: WorkerBridgeCore, match: (line: string) => boolean): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("expected line never arrived")), 10_000);
    const unsubscribe = core.subscribeLines((line) => {
      if (!match(line)) return;
      clearTimeout(timer);
      unsubscribe();
      resolve(line);
    });
  });
}

describe("WorkerBridgeCore", () => {
  test("spawns on demand, frames stdout lines, and dispatches notifications", async () => {
    let startedGeneration = 0;
    const core = makeCore({
      onWorkerStarted: ({ generation }) => {
        startedGeneration = generation;
      },
    });
    expect(core.hasLiveWorker()).toBe(false);
    await waitForHello(core);
    expect(core.hasLiveWorker()).toBe(true);
    expect(core.hasChild()).toBe(true);
    expect(startedGeneration).toBe(1);
    expect(core.workerGeneration()).toBe(1);
  });

  test("request(): correlates a response by id; consume:false also dispatches it", async () => {
    const core = makeCore();
    await waitForHello(core);
    const seen: string[] = [];
    core.subscribeLines((line) => seen.push(line));
    const outcome = await core.request(
      "test/echo",
      { x: 1 },
      { id: "req-1", timeoutMs: 5_000, meta: TEST_META },
    );
    expect(outcome).toEqual({ status: "result", result: { method: "test/echo", echo: { x: 1 } } });
    expect(pendingRequestCount(core)).toBe(0);
    // consume:false — the exact response line still reached line listeners.
    expect(seen.some((l) => l.includes('"req-1"'))).toBe(true);
  });

  test("request(): consume:true settles the caller but hides the line from listeners", async () => {
    const core = makeCore();
    await waitForHello(core);
    const seen: string[] = [];
    core.subscribeLines((line) => seen.push(line));
    const outcome = await core.request("test/echo", undefined, {
      id: "req-consumed",
      timeoutMs: 5_000,
      consume: true,
      meta: TEST_META,
    });
    expect(outcome.status).toBe("result");
    // Flush: round-trip one more visible line, then check the consumed id never surfaced.
    core.sendLine(JSON.stringify({ jsonrpc: "2.0", method: "test/marker" }));
    await waitForLine(core, (l) => l.includes("test/marker"));
    expect(seen.some((l) => l.includes("req-consumed"))).toBe(false);
  });

  test("request(): worker error becomes an error outcome; params omitted when undefined", async () => {
    const core = makeCore();
    await waitForHello(core);
    const outcome = await core.request("test/error", undefined, {
      id: "req-err",
      timeoutMs: 5_000,
      meta: TEST_META,
    });
    expect(outcome).toEqual({ status: "error", error: { code: -32000, message: "boom" } });
  });

  test("request(): times out when the worker never answers", async () => {
    const core = makeCore();
    await waitForHello(core);
    const outcome = await core.request(
      "test/never",
      {},
      {
        id: "req-slow",
        timeoutMs: 200,
        meta: TEST_META,
      },
    );
    expect(outcome).toEqual({ status: "timeout" });
    expect(pendingRequestCount(core)).toBe(0);
  });

  test("request(): failFast settles sendFailed immediately with no worker", async () => {
    const core = makeCore();
    const outcome = await core.request(
      "test/echo",
      {},
      {
        id: "req-dead",
        timeoutMs: 30_000,
        failFast: true,
        meta: TEST_META,
      },
    );
    expect(outcome.status).toBe("sendFailed");
    expect(pendingRequestCount(core)).toBe(0);
  });

  test("request(): a thrown send settles fail-fast exactly once and clears correlation", async () => {
    const core = makeCore({
      prepareInbound: () => {
        throw new Error("write failed");
      },
    });
    const outcome = await core.request(
      "test/echo",
      {},
      {
        id: "req-send-throws",
        timeoutMs: 30_000,
        failFast: true,
        meta: TEST_META,
      },
    );
    expect(outcome).toMatchObject({ status: "sendFailed" });
    expect(pendingRequestCount(core)).toBe(0);
  });

  test("request(): ensureWorker spawns a dead worker before sending, so the request is answered", async () => {
    // Regression: the Mimi Pet / IM-gateway path calls the bridge's
    // requestWorker("agent/run", …) while the worker is lazily unspawned. Without
    // ensureWorker the frame is dropped by sendLine (no child) and the caller
    // hangs to its full timeout — the "Mimi 正在整理…" freeze and unanswered
    // WeChat messages. With ensureWorker the request spawns then sends.
    const core = makeCore();
    expect(core.hasLiveWorker()).toBe(false);
    const outcome = await core.request(
      "test/echo",
      { woke: true },
      { id: "req-wake", timeoutMs: 5_000, ensureWorker: true, meta: TEST_META },
    );
    expect(outcome).toEqual({
      status: "result",
      result: { method: "test/echo", echo: { woke: true } },
    });
    expect(core.hasLiveWorker()).toBe(true);
  });

  test("request(): only the first duplicate response settles the correlation", async () => {
    const core = makeCore();
    await waitForHello(core);

    const outcome = await core.request(
      "test/duplicate",
      {},
      {
        id: "req-duplicate",
        timeoutMs: 5_000,
        consume: true,
        settleOnExit: true,
        meta: TEST_META,
      },
    );
    const marker = waitForLine(core, (line) => line.includes("test/marker-after-duplicate"));
    core.sendLine(JSON.stringify({ jsonrpc: "2.0", method: "test/marker-after-duplicate" }));
    await marker;

    expect(outcome).toEqual({ status: "result", result: { sequence: 1 } });
    expect(pendingRequestCount(core)).toBe(0);
  });

  test("request(): prepareInbound registers and strips host-only agent/run metadata", async () => {
    let registered: { sessionId: string; bucket: string; cwd: string } | undefined;
    let receivedMeta: WorkerFrameMeta | undefined;
    const core = makeCore({
      prepareInbound: (line, meta) => {
        receivedMeta = meta;
        const frame = JSON.parse(line) as {
          method?: string;
          params?: Record<string, unknown>;
        };
        if (frame.method === "agent/run" && frame.params) {
          registered = {
            sessionId: String(frame.params.sessionId),
            bucket: String(frame.params.bucket),
            cwd: String(frame.params.cwd),
          };
          delete frame.params.bucket;
          frame.params.projectTrusted = true;
        }
        return { line: JSON.stringify(frame), method: frame.method };
      },
    });

    const outcome = await core.request(
      "agent/run",
      {
        sessionId: "restored-session",
        bucket: "project::restored-session",
        cwd: "/project",
      },
      { id: "req-panel-run", timeoutMs: 5_000, ensureWorker: true, meta: TEST_META },
    );

    expect(registered).toEqual({
      sessionId: "restored-session",
      bucket: "project::restored-session",
      cwd: "/project",
    });
    expect(receivedMeta).toEqual(TEST_META);
    expect(outcome).toEqual({
      status: "result",
      result: {
        method: "agent/run",
        echo: {
          sessionId: "restored-session",
          cwd: "/project",
          projectTrusted: true,
        },
      },
    });
  });

  test("request(): settleOnExit resolves pending requests when the worker dies", async () => {
    const exits: WorkerExitInfo[] = [];
    const core = makeCore({ onExit: (info) => exits.push(info) });
    await waitForHello(core);
    const pending = core.request(
      "test/never",
      {},
      {
        id: "req-exit",
        timeoutMs: 30_000,
        settleOnExit: true,
        meta: TEST_META,
      },
    );
    core.sendLine(JSON.stringify({ jsonrpc: "2.0", method: "test/exit" }));
    expect(await pending).toEqual({ status: "workerExit" });
    expect(pendingRequestCount(core)).toBe(0);
    expect(exits).toEqual([{ code: 0, signal: null, clean: true, gaveUp: false }]);
    expect(core.hasLiveWorker()).toBe(false);
  });

  test("injectWorkerMessage(): prepareInbound rewrites the line before it hits the worker", async () => {
    let receivedMeta: WorkerFrameMeta | undefined;
    const core = makeCore({
      prepareInbound: (line, meta) => {
        receivedMeta = meta;
        return {
          line: line.replace("original", "rewritten"),
          method: "test/inject",
        };
      },
    });
    await waitForHello(core);
    const echoed = waitForLine(core, (l) => l.includes("test/received"));
    core.injectWorkerMessage(
      JSON.stringify({ jsonrpc: "2.0", method: "original/notify" }),
      TEST_META,
    );
    const received = JSON.parse(await echoed) as { params: { line: string } };
    expect(received.params.line).toContain("rewritten/notify");
    expect(received.params.line).not.toContain("original");
    expect(receivedMeta).toEqual(TEST_META);
  });

  test("injectWorkerMessage() and sendLine() drop safely with no live worker", () => {
    const dropped: Array<Record<string, unknown> | undefined> = [];
    const core = makeCore({
      log: (event, data) => {
        if (event === "inject.dropped") dropped.push(data);
      },
    });
    expect(core.sendLine("{}")).toBe(false);
    core.injectWorkerMessage(
      JSON.stringify({ jsonrpc: "2.0", method: "agent/approve" }),
      TEST_META,
    );
    expect(dropped).toEqual([
      {
        reason: "no child",
        method: undefined,
        origin: "host",
        producer: "worker-bridge-test",
      },
    ]);
  });
});

describe("previewLine", () => {
  test("truncates long lines and passes short ones through", () => {
    expect(previewLine("short")).toBe("short");
    expect(previewLine("a".repeat(205))).toBe("a".repeat(200) + "…(+5 more)");
  });
});
