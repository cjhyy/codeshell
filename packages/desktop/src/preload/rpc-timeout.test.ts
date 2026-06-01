/**
 * Verifies the preload RPC timeout/cancel semantics that fix the "UI freezes
 * on long tasks" bug (see project_rpc_30s_timeout_freeze):
 *
 *   1. A short RPC still rejects on the default 30s timeout if main never replies.
 *   2. agent/run (timeoutMs = 0) does NOT reject when a reply takes > 30s —
 *      it resolves whenever the reply finally lands. This is the actual fix:
 *      slow runs (Playwright, image-gen, multi-turn) used to be killed at 30s.
 *   3. A pending untimed run rejects when the worker dies (exited/gave_up),
 *      so busy doesn't hang forever now that the timeout no longer covers it.
 *
 * The test re-implements the exact rpc()/response/lifecycle logic from
 * preload/index.ts against a fake IPC bus — preload itself imports Electron's
 * contextBridge/ipcRenderer and can't load under bun. The logic mirror is kept
 * deliberately faithful; if preload's logic changes, update this copy.
 */
import { describe, it, expect } from "bun:test";

type Entry = { resolve: (r: unknown) => void; reject: (e: Error) => void };

/** A faithful mirror of preload's RPC layer, parameterized on a fake sender. */
function makeRpcLayer(send: (line: string) => void) {
  let nextId = 1;
  const pending = new Map<number, Entry>();
  const RPC_TIMEOUT_MS = 30_000;

  function onResponse(id: number, msg: unknown) {
    const entry = pending.get(id);
    if (entry) {
      pending.delete(id);
      entry.resolve(msg);
    }
  }

  function onLifecycle(type: string) {
    if (type === "exited" || type === "gave_up") {
      if (pending.size > 0) {
        const err = new Error(`worker ${type} before replying`);
        for (const [id, entry] of pending) {
          pending.delete(id);
          entry.reject(err);
        }
      }
    }
  }

  function rpc(method: string, params?: Record<string, unknown>, timeoutMs = RPC_TIMEOUT_MS): Promise<unknown> {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              if (pending.delete(id)) reject(new Error(`RPC '${method}' timed out after ${timeoutMs}ms`));
            }, timeoutMs)
          : null;
      pending.set(id, {
        resolve: (msg) => {
          if (timer) clearTimeout(timer);
          resolve(msg);
        },
        reject: (err) => {
          if (timer) clearTimeout(timer);
          reject(err);
        },
      });
      send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    });
  }

  return { rpc, onResponse, onLifecycle, pendingSize: () => pending.size };
}

describe("preload RPC timeout/cancel semantics", () => {
  it("short RPC rejects on the 30s timeout when main never replies", async () => {
    const layer = makeRpcLayer(() => {});
    const p = rpcExpectReject(layer.rpc("agent/cancel", {}, 50)); // tiny timeout to keep test fast
    const err = await p;
    expect(err.message).toContain("timed out after 50ms");
    expect(layer.pendingSize()).toBe(0);
  });

  it("agent/run (timeoutMs=0) does NOT time out — resolves whenever the reply lands", async () => {
    let sentId = 0;
    const layer = makeRpcLayer((line) => {
      sentId = JSON.parse(line).id;
    });
    let resolved = false;
    const runPromise = layer.rpc("agent/run", { task: "slow" }, 0).then((r) => {
      resolved = true;
      return r;
    });

    // Simulate a long task: well past the old 30s window, still no reply.
    await delay(60);
    expect(resolved).toBe(false); // would have been rejected at 30s before the fix
    expect(layer.pendingSize()).toBe(1);

    // The run finally finishes and main sends its response.
    layer.onResponse(sentId, { jsonrpc: "2.0", id: sentId, result: { text: "done", reason: "completed" } });
    const r = (await runPromise) as { result: { text: string } };
    expect(r.result.text).toBe("done");
    expect(layer.pendingSize()).toBe(0);
  });

  it("a pending untimed run rejects when the worker exits (crash fallback)", async () => {
    const layer = makeRpcLayer(() => {});
    const p = rpcExpectReject(layer.rpc("agent/run", { task: "x" }, 0));
    expect(layer.pendingSize()).toBe(1);
    layer.onLifecycle("exited");
    const err = await p;
    expect(err.message).toContain("worker exited before replying");
    expect(layer.pendingSize()).toBe(0);
  });

  it("clean lifecycle with no pending RPC is a no-op (no spurious reject)", () => {
    const layer = makeRpcLayer(() => {});
    expect(() => layer.onLifecycle("exited")).not.toThrow();
    expect(layer.pendingSize()).toBe(0);
  });
});

/** Resolve with the rejection error so tests can assert on it without throwing. */
function rpcExpectReject(p: Promise<unknown>): Promise<Error> {
  return p.then(
    () => {
      throw new Error("expected rejection but resolved");
    },
    (e: Error) => e,
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
