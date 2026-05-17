# LLM/UI Decoupling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate UI freezes during LLM upstream hangs, give Esc/Ctrl+C an unconditional 100 ms response budget, preserve partial assistant text on interruption, and add a background sub-agent dock with view switching.

**Architecture:** Four-layer decoupling borrowed from Claude Code 2.1.88 — (1) stream idle watchdog in the openai provider, (2) `QueryGuard` synchronous state machine + `useSyncExternalStore`, (3) derived multi-source `isRunning`, (4) UI-side partial preservation on abort. Plus a P3 dock surfacing `Agent(run_in_background=true)` agents with Ctrl-digit view switching.

**Tech Stack:** TypeScript (strict), React 19, bun (test + runtime), ink (custom fork in `src/render/`), Node ≥ 20.10, openai SDK for streaming.

**Spec:** [`docs/superpowers/specs/2026-05-17-llm-ui-decoupling-design.md`](../specs/2026-05-17-llm-ui-decoupling-design.md)

---

## Pre-Flight (run once before Phase 1)

These verify assumptions made in the spec. If any fail, stop and update the spec before continuing.

- [ ] **PF-1: Confirm React 19 + bun + ink supports `useSyncExternalStore`**

Write a smoke script that mounts a tiny `useSyncExternalStore` consumer in ink and forces 3 store mutations. Pass = renders 3 distinct outputs without "infinite loop" or "tearing" warnings.

Create: `scripts/smoke-sync-store.ts`

```ts
import React, { useSyncExternalStore } from "react";
import { render, Box, Text } from "../src/render/index.js";

class Store {
  private n = 0;
  private listeners = new Set<() => void>();
  subscribe = (cb: () => void) => { this.listeners.add(cb); return () => this.listeners.delete(cb); };
  getSnapshot = () => this.n;
  tick() { this.n++; for (const l of this.listeners) l(); }
}
const store = new Store();

function App() {
  const n = useSyncExternalStore(store.subscribe, store.getSnapshot);
  return <Box><Text>tick={n}</Text></Box>;
}

const instance = render(<App />);
let count = 0;
const id = setInterval(() => {
  store.tick();
  count++;
  if (count >= 3) {
    clearInterval(id);
    setTimeout(() => { instance.unmount(); process.exit(0); }, 100);
  }
}, 100);
```

Run: `bun run scripts/smoke-sync-store.ts`
Expected: process exits cleanly within 1 s, no error output.

If this fails, the entire Phase 2 plan needs a different approach (e.g. `useSyncExternalStoreWithSelector` or a context-based store).

- [ ] **PF-2: Confirm AbortSignal.any() exists at runtime**

Run: `bun -e "console.log(typeof AbortSignal.any)"`
Expected: `function`

If `undefined`, Phase 1 must polyfill (write a tiny `mergeSignals(a, b)` helper instead of using `.any`). Note this finding in the Phase 1 task before continuing.

- [ ] **PF-3: Confirm engine.ts does NOT already write a transcript entry on AbortError**

Run: `grep -nE "AbortError|catch.*signal|catch.*abort" /Users/admin/Documents/个人学习/代码学习/codeshell/src/engine/engine.ts`
Expected: no matches that write into chatStore/transcript. The engine surfaces `result.reason = "aborted_streaming"` but does not push interrupt text — UI owns that.

If matches indicate engine writes interrupt text, add **Task 3.5** to remove that write before Phase 3's Esc handler ships.

---

## File Structure

**Phase 1 (P0):**
- Create: `src/llm/stream-watchdog.ts` — Watchdog class + factory + error type. ~80 lines.
- Create: `tests/llm/stream-watchdog.test.ts` — unit tests for the watchdog primitive.
- Create: `tests/llm/openai-stream-watchdog.test.ts` — integration: a hanging mock stream triggers the watchdog through the openai provider.
- Modify: `src/llm/providers/openai.ts:249` — wrap the `for await` with watchdog reset/dispose.
- Modify: `src/engine/turn-loop.ts` (or wherever LLM errors get classified) — register `StreamIdleTimeoutError` as retryable.

**Phase 2 (P1):**
- Create: `src/ui/query-guard.ts` — `QueryGuard` class with reserve/tryStart/end/forceEnd/getSignal.
- Create: `tests/ui/query-guard.test.ts` — 7 contract tests.
- Modify: `src/ui/App.tsx` — replace `useState(isRunning)` with `QueryGuard` + `useSyncExternalStore` at all 5 call sites.

**Phase 3 (P2):**
- Modify: `src/ui/store.ts` — add `commitInterruptedStreaming(suffix)` helper.
- Create: `tests/ui/store-commit-interrupted.test.ts` — unit tests.
- Modify: `src/ui/App.tsx` — Esc/Ctrl+C handlers call `chatStore.commitInterruptedStreaming` before `queryGuard.forceEnd`.
- Create: `tests/ui/abort-flow.test.ts` — integration: forceEnd preserves partial, watchdog path writes timeout system message.

**Phase 4 (P3 base):**
- Modify: `src/tool-system/builtin/agent-registry.ts` — add `subscribe`/`getSnapshot`/`hasRunning` + call `notify()` from every mutator.
- Create: `tests/tool-system/agent-registry-subscribe.test.ts` — subscribe + stable snapshot contract.
- Create: `src/ui/components/AgentDock.tsx` — bottom bar showing running background agents.
- Create: `tests/ui/agent-dock.test.tsx` — empty/render/timer-scope.
- Modify: `src/ui/App.tsx` — mount `<AgentDock />` above the input box; derive `isRunning = isQueryActive || hasRunningBgAgents`.

**Phase 5 (P3 full):**
- Modify: `src/tool-system/builtin/agent-registry.ts` — add `transcript: ChatEntry[]` to `AsyncAgentEntry`, plus `appendToTranscript(agentId, entry)`.
- Modify: `src/tool-system/builtin/agent.ts` — wire `runSubAgent`'s stream callback to append to the agent's transcript when `run_in_background=true`.
- Modify: `src/ui/App.tsx` — add `viewMode` state, Ctrl-digit key handlers, switch transcript source rendered by `VirtualMessageList`.
- Create: `tests/ui/agent-view-switching.test.tsx` — Ctrl-1 switches view, transcript content matches agent's recorded stream.

---

## Phase 1 — Stream Idle Watchdog (P0, 0.5 day)

### Task 1.1: StreamIdleTimeoutError + Watchdog primitive (TDD)

**Files:**
- Create: `src/llm/stream-watchdog.ts`
- Test: `tests/llm/stream-watchdog.test.ts`

- [ ] **Step 1: Write the failing test file**

Create `tests/llm/stream-watchdog.test.ts`:

```ts
import { test, expect } from "bun:test";
import { createStreamWatchdog, StreamIdleTimeoutError } from "../../src/llm/stream-watchdog.js";

test("idle watchdog fires onTimeout after idleTimeoutMs with no resets", async () => {
  let timedOut = false;
  const wd = createStreamWatchdog({
    idleTimeoutMs: 50,
    onTimeout: () => { timedOut = true; },
  });
  await new Promise((r) => setTimeout(r, 80));
  expect(timedOut).toBe(true);
  wd.dispose();
});

test("reset() before timeout prevents onTimeout", async () => {
  let timedOut = false;
  const wd = createStreamWatchdog({
    idleTimeoutMs: 50,
    onTimeout: () => { timedOut = true; },
  });
  for (let i = 0; i < 4; i++) {
    await new Promise((r) => setTimeout(r, 20));
    wd.reset();
  }
  expect(timedOut).toBe(false);
  wd.dispose();
});

test("dispose() prevents future onTimeout firings", async () => {
  let timedOut = false;
  const wd = createStreamWatchdog({
    idleTimeoutMs: 50,
    onTimeout: () => { timedOut = true; },
  });
  wd.dispose();
  await new Promise((r) => setTimeout(r, 80));
  expect(timedOut).toBe(false);
});

test("onWarning fires at idleTimeoutMs/2 by default", async () => {
  let warned = 0;
  const wd = createStreamWatchdog({
    idleTimeoutMs: 100,
    onTimeout: () => {},
    onWarning: () => { warned++; },
  });
  await new Promise((r) => setTimeout(r, 70));
  expect(warned).toBe(1);
  wd.dispose();
});

test("StreamIdleTimeoutError carries idleMs and requestId", () => {
  const e = new StreamIdleTimeoutError(90000, "req_abc");
  expect(e.kind).toBe("stream-idle-timeout");
  expect(e.idleMs).toBe(90000);
  expect(e.requestId).toBe("req_abc");
  expect(e.name).toBe("StreamIdleTimeoutError");
});
```

- [ ] **Step 2: Run the tests, confirm they fail**

Run: `bun test tests/llm/stream-watchdog.test.ts`
Expected: 5 failures — `Cannot find module '../../src/llm/stream-watchdog.js'`.

- [ ] **Step 3: Implement the watchdog**

Create `src/llm/stream-watchdog.ts`:

```ts
/**
 * Stream Idle Watchdog — guarantees an upper bound on the time a streaming
 * LLM call can spend with no bytes arriving. Without this, a wedged HTTP/2
 * connection can hang the session indefinitely; the SDK's request timeout
 * only covers the initial fetch, not the streaming body.
 *
 * Disabled by default. Enabled via env CODESHELL_ENABLE_STREAM_WATCHDOG=1.
 */

export interface StreamWatchdogOptions {
  /** Abort the stream when no chunks arrive within this window. */
  idleTimeoutMs: number;
  /** Called when the watchdog decides to abort. */
  onTimeout: () => void;
  /**
   * Called at idleTimeoutMs/2 (or warningMs if provided). Logging only —
   * the watchdog does not abort on warning.
   */
  onWarning?: (idleMsSoFar: number) => void;
  /** Override the warning trigger; defaults to idleTimeoutMs / 2. */
  warningMs?: number;
}

export interface StreamWatchdog {
  /** Re-arm both timers — call after every chunk. */
  reset(): void;
  /** Clear all timers permanently — call in finally. */
  dispose(): void;
}

export class StreamIdleTimeoutError extends Error {
  readonly kind = "stream-idle-timeout";
  constructor(
    public idleMs: number,
    public requestId?: string,
  ) {
    super(`Stream idle for ${idleMs}ms — aborted`);
    this.name = "StreamIdleTimeoutError";
  }
}

export function createStreamWatchdog(opts: StreamWatchdogOptions): StreamWatchdog {
  const warnMs = opts.warningMs ?? Math.floor(opts.idleTimeoutMs / 2);
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let warnTimer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  function arm(): void {
    if (disposed) return;
    if (opts.onWarning) {
      warnTimer = setTimeout(() => {
        opts.onWarning?.(warnMs);
      }, warnMs);
    }
    idleTimer = setTimeout(() => {
      opts.onTimeout();
    }, opts.idleTimeoutMs);
  }

  function clear(): void {
    if (idleTimer !== null) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
    if (warnTimer !== null) {
      clearTimeout(warnTimer);
      warnTimer = null;
    }
  }

  arm();

  return {
    reset() {
      if (disposed) return;
      clear();
      arm();
    },
    dispose() {
      disposed = true;
      clear();
    },
  };
}

/** Environment-driven defaults. Read once at import time is fine — these never change inside a process. */
export const STREAM_WATCHDOG_CONFIG = {
  enabled: process.env.CODESHELL_ENABLE_STREAM_WATCHDOG === "1",
  idleTimeoutMs:
    parseInt(process.env.CODESHELL_STREAM_IDLE_TIMEOUT_MS || "", 10) || 90_000,
  retries:
    parseInt(process.env.CODESHELL_STREAM_WATCHDOG_RETRIES || "", 10) || 2,
};
```

- [ ] **Step 4: Run the tests, confirm all 5 pass**

Run: `bun test tests/llm/stream-watchdog.test.ts`
Expected: 5/5 pass.

- [ ] **Step 5: Commit**

```bash
git add src/llm/stream-watchdog.ts tests/llm/stream-watchdog.test.ts
git commit -m "feat(llm): stream-idle watchdog primitive + StreamIdleTimeoutError"
```

---

### Task 1.2: Integrate watchdog into openai provider

**Files:**
- Modify: `src/llm/providers/openai.ts:249`
- Test: `tests/llm/openai-stream-watchdog.test.ts`

- [ ] **Step 1: Write the failing integration test**

Create `tests/llm/openai-stream-watchdog.test.ts`:

```ts
import { test, expect } from "bun:test";
import { StreamIdleTimeoutError } from "../../src/llm/stream-watchdog.js";

/**
 * Drive the openai provider with a fake async iterator that yields one chunk
 * then hangs. With the watchdog enabled (idleTimeoutMs=100), the second
 * iteration should be aborted by StreamIdleTimeoutError.
 *
 * We bypass the real openai SDK by injecting a fake stream into the provider's
 * stream() implementation. The provider exposes a `__streamFromIterator` hook
 * for tests; if no such hook exists yet, this task adds it.
 */
test("watchdog aborts the for-await when stream hangs after first chunk", async () => {
  process.env.CODESHELL_ENABLE_STREAM_WATCHDOG = "1";
  process.env.CODESHELL_STREAM_IDLE_TIMEOUT_MS = "100";

  const { runStreamWithWatchdog } = await import("../../src/llm/providers/openai.js");

  async function* hangAfterFirst() {
    yield { choices: [{ delta: { content: "hello" } }] };
    // Now hang forever.
    await new Promise(() => {});
  }

  await expect(
    runStreamWithWatchdog(hangAfterFirst() as any, { idleTimeoutMs: 100 }),
  ).rejects.toBeInstanceOf(StreamIdleTimeoutError);

  delete process.env.CODESHELL_ENABLE_STREAM_WATCHDOG;
  delete process.env.CODESHELL_STREAM_IDLE_TIMEOUT_MS;
});

test("watchdog does not abort a fast stream", async () => {
  async function* fast() {
    yield { choices: [{ delta: { content: "a" } }] };
    yield { choices: [{ delta: { content: "b" } }] };
    yield { choices: [{ delta: { content: "c" } }] };
  }

  const { runStreamWithWatchdog } = await import("../../src/llm/providers/openai.js");
  const text = await runStreamWithWatchdog(fast() as any, { idleTimeoutMs: 100 });
  expect(text).toBe("abc");
});
```

- [ ] **Step 2: Run the test, confirm it fails**

Run: `bun test tests/llm/openai-stream-watchdog.test.ts`
Expected: failure — `runStreamWithWatchdog` is not exported from openai.ts.

- [ ] **Step 3: Refactor openai.ts to expose a watchdog-wrapped consumer**

Read `src/llm/providers/openai.ts` around line 240–320 to see the current `for await (const chunk of stream)` loop.

Add a new exported helper above the class (or at module scope) and have the class call it. The helper is:

```ts
import {
  createStreamWatchdog,
  STREAM_WATCHDOG_CONFIG,
  StreamIdleTimeoutError,
} from "../stream-watchdog.js";

interface RunStreamOpts {
  idleTimeoutMs?: number;
  requestId?: string;
  /**
   * Per-chunk handler — invoked synchronously with the raw chunk for the
   * provider to do its own parsing. Returns the text delta (or empty) for
   * the watchdog-side text accumulator used in tests.
   */
  onChunk?: (chunk: any) => string;
}

/**
 * Consume an async iterable of stream chunks with an idle watchdog.
 * Returns the accumulated text from onChunk (useful for tests; the real
 * provider uses onChunk for full parsing and ignores the return).
 */
export async function runStreamWithWatchdog<T = any>(
  stream: AsyncIterable<T>,
  opts: RunStreamOpts = {},
): Promise<string> {
  const idleTimeoutMs =
    opts.idleTimeoutMs ?? STREAM_WATCHDOG_CONFIG.idleTimeoutMs;
  let text = "";

  if (!STREAM_WATCHDOG_CONFIG.enabled && !opts.idleTimeoutMs) {
    // Fast path: watchdog disabled and caller did not override — no overhead.
    for await (const chunk of stream) {
      if (opts.onChunk) text += opts.onChunk(chunk) ?? "";
    }
    return text;
  }

  let timedOut = false;
  const wd = createStreamWatchdog({
    idleTimeoutMs,
    onTimeout: () => {
      timedOut = true;
    },
  });

  try {
    for await (const chunk of stream) {
      if (timedOut) {
        throw new StreamIdleTimeoutError(idleTimeoutMs, opts.requestId);
      }
      wd.reset();
      if (opts.onChunk) text += opts.onChunk(chunk) ?? "";
    }
    if (timedOut) {
      throw new StreamIdleTimeoutError(idleTimeoutMs, opts.requestId);
    }
  } finally {
    wd.dispose();
  }
  return text;
}
```

Now modify the existing `for await (const chunk of stream)` body inside the provider's stream method (around `src/llm/providers/openai.ts:249`) to route through this helper. Move the existing parse logic into an `onChunk` callback. Approximate shape:

```ts
// Replace the existing `for await (const chunk of stream) { ... }` block with:
const requestId = (stream as any).request_id;
const handleChunk = (chunk: any): string => {
  // ── existing chunk-parse body goes here verbatim ──
  // (capture usage, delta, reasoning_content, tool_calls, finish_reason).
  // Return the text delta (delta.content) if any, otherwise "".
  if ((chunk as any).usage) streamUsage = (chunk as any).usage;
  const delta = chunk.choices[0]?.delta;
  if (!delta) return "";
  // ... rest of existing logic ...
  return delta.content ?? "";
};

await runStreamWithWatchdog(stream, {
  idleTimeoutMs: STREAM_WATCHDOG_CONFIG.idleTimeoutMs,
  requestId,
  onChunk: handleChunk,
});
```

**Important:** preserve all existing side effects of the chunk-parse body (`text += ...`, `toolCallsMap` mutation, `options.onChunk?.(...)` UI-stream events, TTFT logging). The new helper only adds the watchdog; it doesn't change parse semantics.

If the parse body uses early `continue;` to skip a chunk, rewrite as `return "";` since it's now inside a function. If it uses `break;`, you cannot break out of a callback — use a captured flag and throw a sentinel inside the loop instead. Audit the original 249–320 block for these constructs before refactoring.

- [ ] **Step 4: Run the integration test, confirm it passes**

Run: `bun test tests/llm/openai-stream-watchdog.test.ts`
Expected: 2/2 pass.

- [ ] **Step 5: Run the full test suite, confirm no regression**

Run: `bun test`
Expected: all tests pass (existing openai tests unaffected since watchdog is disabled by default).

- [ ] **Step 6: Commit**

```bash
git add src/llm/providers/openai.ts tests/llm/openai-stream-watchdog.test.ts
git commit -m "feat(llm): wire stream-idle watchdog into openai provider"
```

---

### Task 1.3: Make `StreamIdleTimeoutError` retryable in the engine

**Files:**
- Modify: `src/engine/turn-loop.ts` (or wherever the retry classifier lives — search for "retryable" first)
- Test: `tests/engine/retry-stream-idle.test.ts`

- [ ] **Step 1: Locate the retry classifier**

Run: `grep -rn "retryable\|RetryableError\|shouldRetry" /Users/admin/Documents/个人学习/代码学习/codeshell/src/engine/ /Users/admin/Documents/个人学习/代码学习/codeshell/src/llm/ | head -20`

Expected: a function or constant that classifies which errors trigger retry. Note its exact file path and line range.

If no such classifier exists (current provider may not retry on transient errors at all), add a minimal one in `src/llm/retry.ts`:

```ts
import { StreamIdleTimeoutError } from "./stream-watchdog.js";

export function isRetryable(err: unknown): boolean {
  if (err instanceof StreamIdleTimeoutError) return true;
  // Future: add other transient errors here (5xx, 429, ECONNRESET, etc.)
  return false;
}
```

- [ ] **Step 2: Write the failing test**

Create `tests/engine/retry-stream-idle.test.ts`:

```ts
import { test, expect } from "bun:test";
import { StreamIdleTimeoutError } from "../../src/llm/stream-watchdog.js";
import { isRetryable } from "../../src/llm/retry.js";

test("StreamIdleTimeoutError is retryable", () => {
  const err = new StreamIdleTimeoutError(90000, "req_x");
  expect(isRetryable(err)).toBe(true);
});

test("APIUserAbortError (or plain AbortError) is NOT retryable", () => {
  const abortErr = new Error("aborted");
  abortErr.name = "AbortError";
  expect(isRetryable(abortErr)).toBe(false);
});

test("generic Error is NOT retryable", () => {
  expect(isRetryable(new Error("boom"))).toBe(false);
});
```

- [ ] **Step 3: Run the test, confirm it fails**

Run: `bun test tests/engine/retry-stream-idle.test.ts`
Expected: failure — `src/llm/retry.ts` does not exist.

- [ ] **Step 4: Create `src/llm/retry.ts`**

```ts
import { StreamIdleTimeoutError } from "./stream-watchdog.js";

/**
 * Classify whether an error should trigger an automatic retry of the
 * streaming LLM call. User-initiated aborts (AbortError) are never retried;
 * stream-idle timeouts are — the upstream may have recovered.
 */
export function isRetryable(err: unknown): boolean {
  if (err instanceof StreamIdleTimeoutError) return true;
  return false;
}
```

- [ ] **Step 5: Wire `isRetryable` into the existing turn-loop catch path**

Read the area you located in Step 1. The pattern will look like:

```ts
} catch (err) {
  // existing handling
}
```

Wrap the LLM call with retry-on-stream-idle, bounded by `STREAM_WATCHDOG_CONFIG.retries`. Sketch:

```ts
import { STREAM_WATCHDOG_CONFIG } from "../llm/stream-watchdog.js";
import { isRetryable } from "../llm/retry.js";

let attempt = 0;
const maxAttempts = STREAM_WATCHDOG_CONFIG.retries + 1; // 1 initial + N retries
while (true) {
  try {
    return await llmClient.stream(...);
  } catch (err) {
    attempt++;
    if (attempt >= maxAttempts || !isRetryable(err)) throw err;
    const backoff = Math.min(1000 * 2 ** (attempt - 1), 10_000);
    logger.warn("llm.retry", { attempt, error: String(err), backoffMs: backoff });
    await new Promise((r) => setTimeout(r, backoff));
  }
}
```

**Place this wrapper at the lowest level that still has the full context** (provider params, signal, request id). Do NOT retry user-cancellations — `signal.aborted` check before each retry, abort if so.

- [ ] **Step 6: Run tests**

Run: `bun test tests/engine/retry-stream-idle.test.ts && bun test`
Expected: new test passes; existing suite passes.

- [ ] **Step 7: Commit**

```bash
git add src/llm/retry.ts tests/engine/retry-stream-idle.test.ts src/engine/turn-loop.ts
git commit -m "feat(engine): retry on StreamIdleTimeoutError, bounded by env"
```

---

### Task 1.4: Phase 1 manual acceptance + telemetry sanity

- [ ] **Step 1: Verify env-disabled path is dormant**

Run: `bun test` with no env vars set.
Expected: all tests pass. Confirm by reading `STREAM_WATCHDOG_CONFIG.enabled` — should be `false`.

- [ ] **Step 2: Add a doc note**

Modify `README.md` or `docs/architecture/` (whichever doc currently lists env vars). Append:

```markdown
### Stream Idle Watchdog (opt-in)

When `CODESHELL_ENABLE_STREAM_WATCHDOG=1`, the openai provider aborts any LLM stream that has gone `CODESHELL_STREAM_IDLE_TIMEOUT_MS` ms (default 90000) without a chunk. The engine retries up to `CODESHELL_STREAM_WATCHDOG_RETRIES` (default 2) times with exponential backoff. After all retries are exhausted, the turn surfaces a `StreamIdleTimeoutError`.

User-initiated aborts (Esc/Ctrl+C) are never retried.
```

- [ ] **Step 3: Commit docs**

```bash
git add README.md
git commit -m "docs: stream-idle watchdog env vars"
```

**Phase 1 complete.** This already eliminates the multi-minute UI freezes when run with `CODESHELL_ENABLE_STREAM_WATCHDOG=1`.

---

## Phase 2 — QueryGuard + useSyncExternalStore (P1, 1 day)

### Task 2.1: `QueryGuard` class (TDD)

**Files:**
- Create: `src/ui/query-guard.ts`
- Test: `tests/ui/query-guard.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/ui/query-guard.test.ts`:

```ts
import { test, expect, mock } from "bun:test";
import { QueryGuard } from "../../src/ui/query-guard.js";

test("idle → reserve → tryStart → end happy path", () => {
  const g = new QueryGuard();
  expect(g.getSnapshot()).toBe(false);
  expect(g.reserve()).toBe(true);
  expect(g.getSnapshot()).toBe(true);
  const ac = new AbortController();
  expect(g.tryStart(ac)).toBe(true);
  expect(g.getSnapshot()).toBe(true);
  expect(g.getSignal()).toBe(ac.signal);
  g.end();
  expect(g.getSnapshot()).toBe(false);
  expect(g.getSignal()).toBe(null);
});

test("second reserve while busy returns false", () => {
  const g = new QueryGuard();
  expect(g.reserve()).toBe(true);
  expect(g.reserve()).toBe(false);
});

test("tryStart without reserve returns false", () => {
  const g = new QueryGuard();
  const ac = new AbortController();
  expect(g.tryStart(ac)).toBe(false);
  expect(g.getSnapshot()).toBe(false);
});

test("forceEnd while running aborts the controller", () => {
  const g = new QueryGuard();
  g.reserve();
  const ac = new AbortController();
  g.tryStart(ac);
  const abortSpy = mock(() => {});
  ac.signal.addEventListener("abort", abortSpy);
  g.forceEnd("user-cancel");
  expect(abortSpy).toHaveBeenCalledTimes(1);
  expect(ac.signal.aborted).toBe(true);
  expect(g.getSnapshot()).toBe(false);
});

test("forceEnd while reserved (no controller yet) returns to idle without throwing", () => {
  const g = new QueryGuard();
  g.reserve();
  expect(() => g.forceEnd("user-cancel")).not.toThrow();
  expect(g.getSnapshot()).toBe(false);
});

test("listener is notified exactly once per transition", () => {
  const g = new QueryGuard();
  const cb = mock(() => {});
  g.subscribe(cb);
  g.reserve();          // 1 notify
  g.tryStart(new AbortController()); // 2
  g.end();              // 3
  expect(cb).toHaveBeenCalledTimes(3);
});

test("unsubscribe stops future notifications", () => {
  const g = new QueryGuard();
  const cb = mock(() => {});
  const unsub = g.subscribe(cb);
  g.reserve();
  unsub();
  g.end();
  g.reserve();
  expect(cb).toHaveBeenCalledTimes(1);
});

test("cancelReservation rolls back reserve()", () => {
  const g = new QueryGuard();
  g.reserve();
  g.cancelReservation();
  expect(g.getSnapshot()).toBe(false);
  // Should be reservable again
  expect(g.reserve()).toBe(true);
});
```

- [ ] **Step 2: Run the tests, confirm they fail**

Run: `bun test tests/ui/query-guard.test.ts`
Expected: failures — `Cannot find module '../../src/ui/query-guard.js'`.

- [ ] **Step 3: Implement `QueryGuard`**

Create `src/ui/query-guard.ts`:

```ts
/**
 * QueryGuard — synchronous state machine for "is a query in flight".
 * Replaces React useState for isRunning. Subscribers (via useSyncExternalStore)
 * see state changes immediately, bypassing React 18 batching that otherwise
 * opens a 1–10 ms window for double-submit / dead-click bugs.
 *
 * States:
 *   idle      — no query active
 *   reserved  — processUserInput started its sync prep but hasn't created the AbortController yet
 *   running   — AbortController attached; query is in flight
 *
 * The only writers are reserve/tryStart/cancelReservation/end/forceEnd.
 * No setter is exposed.
 */

export type QueryState = "idle" | "reserved" | "running";

export class QueryGuard {
  private state: QueryState = "idle";
  private controller: AbortController | null = null;
  private listeners = new Set<() => void>();

  // ── useSyncExternalStore contract ──
  subscribe = (cb: () => void): (() => void) => {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  };
  getSnapshot = (): boolean => this.state !== "idle";

  private notify(): void {
    for (const cb of this.listeners) cb();
  }

  /** Reserve a slot synchronously before the AbortController exists. */
  reserve(): boolean {
    if (this.state !== "idle") return false;
    this.state = "reserved";
    this.notify();
    return true;
  }

  /** Attach the AbortController. Must follow reserve(). */
  tryStart(controller: AbortController): boolean {
    if (this.state !== "reserved") return false;
    this.controller = controller;
    this.state = "running";
    this.notify();
    return true;
  }

  /** Roll back reserve() when processUserInput threw before tryStart. */
  cancelReservation(): void {
    if (this.state !== "reserved") return;
    this.state = "idle";
    this.notify();
  }

  /** Normal completion — clean up without aborting (already finished). */
  end(): void {
    if (this.state === "idle") return;
    this.state = "idle";
    this.controller = null;
    this.notify();
  }

  /** Hard abort: abort the controller AND clean up. */
  forceEnd(reason: string = "force-end"): void {
    if (this.state === "running" && this.controller) {
      try {
        this.controller.abort(reason);
      } catch {
        // swallow — listener errors must not block state transition
      }
    }
    this.state = "idle";
    this.controller = null;
    this.notify();
  }

  /** Read the current controller's signal; null when idle/reserved. */
  getSignal(): AbortSignal | null {
    return this.controller?.signal ?? null;
  }
}
```

- [ ] **Step 4: Run the tests, confirm all 8 pass**

Run: `bun test tests/ui/query-guard.test.ts`
Expected: 8/8 pass.

- [ ] **Step 5: Commit**

```bash
git add src/ui/query-guard.ts tests/ui/query-guard.test.ts
git commit -m "feat(ui): QueryGuard sync state machine + tests"
```

---

### Task 2.2: Migrate App.tsx isRunning to QueryGuard

**Files:**
- Modify: `src/ui/App.tsx` (5 call sites)

**Reference**: the 5 sites identified by `grep -n setIsRunning src/ui/App.tsx`:

| Line | Current call | Migrated call |
|---|---|---|
| 136 | `const [isRunning, setIsRunning] = useState(false);` | `const queryGuard = useRef(new QueryGuard()).current;` + `const isRunning = useSyncExternalStore(queryGuard.subscribe, queryGuard.getSnapshot);` |
| 747 | `setIsRunning(false);` (in Esc handler) | `queryGuard.forceEnd("user-cancel");` |
| 807 | `setIsRunning(false);` (in Ctrl+C handler) | `queryGuard.forceEnd("user-cancel");` |
| 910 | `setIsRunning(true);` (handleSubmit start) | See Step 3 (reserve + tryStart split) |
| 1001 | `setIsRunning(false);` (handleSubmit finally) | `queryGuard.end();` |
| 1023 | `setIsRunning,` (passed as prop) | Audit downstream consumer — replace with `queryGuard` reference or remove if unused. See Step 4. |

- [ ] **Step 1: Add the QueryGuard import + ref**

Open `src/ui/App.tsx`. Near the existing React imports (around top), add:

```tsx
import { useSyncExternalStore } from "react";
import { QueryGuard } from "./query-guard.js";
```

At line 136, replace:

```tsx
const [isRunning, setIsRunning] = useState(false);
```

with:

```tsx
const queryGuard = useRef(new QueryGuard()).current;
const isQueryActive = useSyncExternalStore(
  queryGuard.subscribe,
  queryGuard.getSnapshot,
);
// Keep the `isRunning` identifier — too many downstream readers. Source changed.
const isRunning = isQueryActive;
```

- [ ] **Step 2: Migrate the two Esc/Ctrl+C handlers (lines 744-747, 800-807)**

Read the context at line 744 to understand which keypress triggers it. Replace the existing block:

```tsx
client.cancel().catch(() => {});
cancelledRef.current = true;
setIsRunning(false);
```

with:

```tsx
queryGuard.forceEnd("user-cancel");
client.cancel().catch(() => {});
cancelledRef.current = true;
```

(Order matters: `forceEnd` first synchronously updates the guard so any concurrent React render sees the new state, then we call the existing `client.cancel()` to notify the engine.)

Do the same at line 800-807.

- [ ] **Step 3: Migrate handleSubmit — reserve/tryStart pair**

Read `src/ui/App.tsx:883-910`. The current shape:

```tsx
const handleSubmit = useCallback(async (value: string) => {
  // ... existing pre-checks ...
  chatStore.update((prev) => [...prev, entry({ type: "user", text: trimmed })]);
  setIsRunning(true);
  streamingTokensRef.current = 0;
  cancelledRef.current = false;
  taskManager.reset();
  try {
    const result = await client.run(engineMessage, sessionId);
    // ...
  } finally {
    // see Step 4 for the finally migration
  }
});
```

Replace the `setIsRunning(true)` with:

```tsx
if (!queryGuard.reserve()) return; // already busy; ignore concurrent submit
chatStore.update((prev) => [...prev, entry({ type: "user", text: trimmed })]);
streamingTokensRef.current = 0;
cancelledRef.current = false;
taskManager.reset();

const abortController = new AbortController();
if (!queryGuard.tryStart(abortController)) {
  // State raced — should be unreachable since reserve just succeeded synchronously.
  queryGuard.cancelReservation();
  return;
}
```

If `client.run` accepts a `signal` argument, pass `abortController.signal` to it. If it does not (current API uses `client.cancel()`), leave the abortController in place for Phase 3 to wire — for now, `forceEnd` aborts the controller and Phase 3 will route the signal through `client`.

- [ ] **Step 4: Migrate the `finally` and any downstream `setIsRunning` prop**

At line 1001:

```tsx
setIsRunning(false);
```

Replace with:

```tsx
queryGuard.end();
```

At line 1023, search for what consumes the `setIsRunning,` prop. Run:

```bash
grep -n "setIsRunning" src/ui/
```

Identify each consumer. Each one is either:
- A slash command that programmatically ends the turn → replace with `queryGuard.end()`
- A slash command that programmatically starts a turn → replace with `queryGuard.reserve() + tryStart(...)`
- An end-of-engine callback → replace with `queryGuard.end()`

If a consumer cannot be cleanly migrated in this pass, surface it in the PR description and add a follow-up task. Do **not** keep `setIsRunning` as a no-op wrapper — that defeats the purpose of consolidating to the guard.

- [ ] **Step 5: Typecheck**

Run: `bun run typecheck`
Expected: no errors. If errors, address them — likely `setIsRunning` references in slash commands.

- [ ] **Step 6: Run the full test suite**

Run: `bun test`
Expected: all tests pass. If a UI test references `setIsRunning` directly, update it to use `queryGuard.reserve()` / `queryGuard.end()`.

- [ ] **Step 7: Manual smoke**

Run: `bun run dev` (in a separate terminal so this Claude session isn't disturbed).

Open the codeshell UI, type a message, press Enter, then press Esc mid-stream.

Expected:
- The input box returns to "ready" state within ~100 ms.
- The transcript shows the partial assistant message (when Phase 3 ships) — for now it may still be discarded; that's fixed in Phase 3.
- No "React state inconsistent" warnings in the log.

If the input box does NOT recover quickly, stop here and diagnose; this is the core Phase 2 acceptance.

- [ ] **Step 8: Commit**

```bash
git add src/ui/App.tsx
git commit -m "feat(ui): migrate isRunning to QueryGuard + useSyncExternalStore"
```

---

## Phase 3 — Esc Preserves Partial Text (P2, 0.5 day)

### Task 3.1: chatStore.commitInterruptedStreaming helper

**Files:**
- Modify: `src/ui/store.ts`
- Test: `tests/ui/store-commit-interrupted.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/ui/store-commit-interrupted.test.ts`:

```ts
import { test, expect } from "bun:test";
import { chatStore } from "../../src/ui/store.js";

function reset() {
  chatStore.setEntries([]);
}

test("non-empty partial → entry persisted, streaming flag cleared, suffix appended", () => {
  reset();
  chatStore.append({ type: "assistant_text", text: "hello partial", streaming: true });
  chatStore.commitInterruptedStreaming("\n\n[Request interrupted by user]");
  const entries = chatStore.getEntries();
  const last = entries[entries.length - 1];
  expect(last.type).toBe("assistant_text");
  if (last.type === "assistant_text") {
    expect(last.streaming).toBe(false);
    expect(last.text).toBe("hello partial\n\n[Request interrupted by user]");
  }
});

test("empty partial → no entry mutation", () => {
  reset();
  chatStore.append({ type: "assistant_text", text: "   ", streaming: true });
  chatStore.commitInterruptedStreaming("\n\n[Request interrupted by user]");
  const entries = chatStore.getEntries();
  const last = entries[entries.length - 1];
  if (last.type === "assistant_text") {
    expect(last.text).toBe("   "); // unchanged
    expect(last.streaming).toBe(false); // still finalize
  }
});

test("no streaming entry → no-op (does not throw)", () => {
  reset();
  chatStore.append({ type: "user", text: "hi" });
  expect(() => chatStore.commitInterruptedStreaming("...")).not.toThrow();
  expect(chatStore.getEntries().length).toBe(1);
});

test("thinking entries removed alongside commit", () => {
  reset();
  chatStore.append({ type: "thinking", content: "scratch" });
  chatStore.append({ type: "assistant_text", text: "partial", streaming: true });
  chatStore.commitInterruptedStreaming("\n\n[Request interrupted by user]");
  const entries = chatStore.getEntries();
  expect(entries.some((e) => e.type === "thinking")).toBe(false);
});
```

- [ ] **Step 2: Run the tests, confirm they fail**

Run: `bun test tests/ui/store-commit-interrupted.test.ts`
Expected: failures — `commitInterruptedStreaming` is not a function.

- [ ] **Step 3: Add the method to ChatStore**

Open `src/ui/store.ts`. After the existing `update` method (around line 80), add:

```ts
  /**
   * Commit the in-flight streaming assistant entry as a final (non-streaming)
   * message, optionally appending a suffix (e.g., "[Request interrupted by user]").
   * Drops any thinking entries — model scratch, no user value after interruption.
   * No-op if there is no streaming entry.
   *
   * Empty-text streaming entry is finalized in place (streaming=false) without
   * suffix — keeps the store transition consistent without persisting noise.
   */
  commitInterruptedStreaming(suffix: string): void {
    this.entries = this.entries
      .filter((e) => e.type !== "thinking")
      .map((e) => {
        if (e.type !== "assistant_text" || !e.streaming) return e;
        const hasText = e.text.trim().length > 0;
        return {
          ...e,
          streaming: false,
          text: hasText ? e.text + suffix : e.text,
        };
      });
    this.notify();
  }
```

- [ ] **Step 4: Run the tests, confirm all 4 pass**

Run: `bun test tests/ui/store-commit-interrupted.test.ts`
Expected: 4/4 pass.

- [ ] **Step 5: Commit**

```bash
git add src/ui/store.ts tests/ui/store-commit-interrupted.test.ts
git commit -m "feat(ui-store): commitInterruptedStreaming helper + tests"
```

---

### Task 3.2: Wire Esc/Ctrl+C handlers to commit partial before forceEnd

**Files:**
- Modify: `src/ui/App.tsx` (the two handlers that call `queryGuard.forceEnd` from Task 2.2 Step 2)

- [ ] **Step 1: Find the two forceEnd call sites**

Run: `grep -n "queryGuard.forceEnd" src/ui/App.tsx`
Expected: 2 sites (Esc handler and Ctrl+C handler, originally at lines 744-747 and 800-807).

- [ ] **Step 2: Insert commitInterruptedStreaming before each forceEnd**

For each site, replace:

```tsx
queryGuard.forceEnd("user-cancel");
client.cancel().catch(() => {});
cancelledRef.current = true;
```

with:

```tsx
chatStore.commitInterruptedStreaming("\n\n[Request interrupted by user]");
queryGuard.forceEnd("user-cancel");
client.cancel().catch(() => {});
cancelledRef.current = true;
```

Order: commit first (UI side-effect captured before any async cancel races), then forceEnd (synchronous state flip), then `client.cancel()` (network side-effect).

- [ ] **Step 3: Typecheck and test**

Run: `bun run typecheck && bun test`
Expected: clean.

- [ ] **Step 4: Manual smoke**

Run: `bun run dev`. Send a long prompt that triggers a multi-second streaming response. Press Esc mid-stream.

Expected:
- The partially generated assistant text is visible in the transcript.
- It ends with `\n\n[Request interrupted by user]`.
- Input box ready within 100 ms.

- [ ] **Step 5: Commit**

```bash
git add src/ui/App.tsx
git commit -m "feat(ui): preserve partial assistant text on Esc/Ctrl+C"
```

---

### Task 3.3: Abort-flow integration test

**Files:**
- Test: `tests/ui/abort-flow.test.ts`

- [ ] **Step 1: Write the integration test**

Create `tests/ui/abort-flow.test.ts`:

```ts
import { test, expect } from "bun:test";
import { chatStore } from "../../src/ui/store.js";
import { QueryGuard } from "../../src/ui/query-guard.js";

function reset() {
  chatStore.setEntries([]);
}

test("forceEnd + commitInterruptedStreaming yields an interrupted entry", () => {
  reset();
  const g = new QueryGuard();
  g.reserve();
  g.tryStart(new AbortController());

  chatStore.append({ type: "assistant_text", text: "halfway", streaming: true });

  // Simulate Esc
  chatStore.commitInterruptedStreaming("\n\n[Request interrupted by user]");
  g.forceEnd("user-cancel");

  const entries = chatStore.getEntries();
  const assistantEntries = entries.filter((e) => e.type === "assistant_text");
  expect(assistantEntries.length).toBe(1);
  if (assistantEntries[0].type === "assistant_text") {
    expect(assistantEntries[0].streaming).toBe(false);
    expect(assistantEntries[0].text).toContain("halfway");
    expect(assistantEntries[0].text).toContain("[Request interrupted by user]");
  }
  expect(g.getSnapshot()).toBe(false);
});

test("late chunk after forceEnd does not double-write the partial", () => {
  reset();
  const g = new QueryGuard();
  g.reserve();
  g.tryStart(new AbortController());

  chatStore.append({ type: "assistant_text", text: "first half", streaming: true });

  // User Esc
  chatStore.commitInterruptedStreaming("\n\n[Request interrupted by user]");
  g.forceEnd("user-cancel");

  // Late chunk lands — engine catch should NOT re-commit. We simulate by
  // calling commitInterruptedStreaming again (worst case): since the entry
  // is already streaming=false, no second suffix.
  chatStore.commitInterruptedStreaming("\n\n[Request interrupted by user]");

  const entries = chatStore.getEntries();
  const assistantEntries = entries.filter((e) => e.type === "assistant_text");
  expect(assistantEntries.length).toBe(1);
  if (assistantEntries[0].type === "assistant_text") {
    // Suffix appears once, not twice
    const occurrences = assistantEntries[0].text.split("[Request interrupted by user]").length - 1;
    expect(occurrences).toBe(1);
  }
});
```

- [ ] **Step 2: Run the test, confirm it passes**

Run: `bun test tests/ui/abort-flow.test.ts`
Expected: 2/2 pass.

- [ ] **Step 3: Commit**

```bash
git add tests/ui/abort-flow.test.ts
git commit -m "test(ui): abort-flow integration — partial preserved, no double-commit"
```

**Phase 3 complete.**

---

## Phase 4 — Agent Dock Base (P3 part 1, 0.5 day)

### Task 4.1: Registry subscribe/getSnapshot/hasRunning

**Files:**
- Modify: `src/tool-system/builtin/agent-registry.ts`
- Test: `tests/tool-system/agent-registry-subscribe.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/tool-system/agent-registry-subscribe.test.ts`:

```ts
import { test, expect, mock } from "bun:test";
import { asyncAgentRegistry } from "../../src/tool-system/builtin/agent-registry.js";

function resetRegistry() {
  asyncAgentRegistry.reset();
}

test("subscribe receives notify on register", () => {
  resetRegistry();
  const cb = mock(() => {});
  const unsub = asyncAgentRegistry.subscribe(cb);
  asyncAgentRegistry.register({
    agentId: "a1",
    description: "test agent",
    status: "running",
    startedAt: Date.now(),
    abort: () => {},
  });
  expect(cb).toHaveBeenCalledTimes(1);
  unsub();
});

test("getSnapshot returns a stable reference between mutations", () => {
  resetRegistry();
  asyncAgentRegistry.register({
    agentId: "a1",
    description: "x",
    status: "running",
    startedAt: Date.now(),
    abort: () => {},
  });
  const snap1 = asyncAgentRegistry.getSnapshot();
  const snap2 = asyncAgentRegistry.getSnapshot();
  expect(snap1).toBe(snap2); // identity, not value
});

test("getSnapshot returns a NEW reference after notify", () => {
  resetRegistry();
  asyncAgentRegistry.register({
    agentId: "a1",
    description: "x",
    status: "running",
    startedAt: Date.now(),
    abort: () => {},
  });
  const snap1 = asyncAgentRegistry.getSnapshot();
  asyncAgentRegistry.markCompleted("a1", "done");
  const snap2 = asyncAgentRegistry.getSnapshot();
  expect(snap1).not.toBe(snap2);
});

test("hasRunning reflects active agents", () => {
  resetRegistry();
  expect(asyncAgentRegistry.hasRunning()).toBe(false);
  asyncAgentRegistry.register({
    agentId: "a1",
    description: "x",
    status: "running",
    startedAt: Date.now(),
    abort: () => {},
  });
  expect(asyncAgentRegistry.hasRunning()).toBe(true);
  asyncAgentRegistry.markCompleted("a1", "done");
  expect(asyncAgentRegistry.hasRunning()).toBe(false);
});

test("unsubscribe stops future notifications", () => {
  resetRegistry();
  const cb = mock(() => {});
  const unsub = asyncAgentRegistry.subscribe(cb);
  unsub();
  asyncAgentRegistry.register({
    agentId: "a1",
    description: "x",
    status: "running",
    startedAt: Date.now(),
    abort: () => {},
  });
  expect(cb).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run the test, confirm it fails**

Run: `bun test tests/tool-system/agent-registry-subscribe.test.ts`
Expected: failures — `subscribe`/`getSnapshot`/`hasRunning` not defined.

- [ ] **Step 3: Extend `AsyncAgentRegistry`**

Modify `src/tool-system/builtin/agent-registry.ts`. Replace the existing class body with:

```ts
class AsyncAgentRegistry {
  private agents = new Map<string, AsyncAgentEntry>();
  private listeners = new Set<() => void>();
  /** Cached snapshot — rebuilt only inside notify() for useSyncExternalStore stability. */
  private snapshot: AsyncAgentEntry[] = [];

  subscribe = (cb: () => void): (() => void) => {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  };

  getSnapshot = (): AsyncAgentEntry[] => this.snapshot;

  hasRunning = (): boolean => this.snapshot.some((e) => e.status === "running");

  private notify(): void {
    this.snapshot = [...this.agents.values()];
    for (const cb of this.listeners) cb();
  }

  register(entry: AsyncAgentEntry): void {
    this.agents.set(entry.agentId, entry);
    this.notify();
  }

  get(agentId: string): AsyncAgentEntry | undefined {
    return this.agents.get(agentId);
  }

  list(): AsyncAgentEntry[] {
    return [...this.agents.values()];
  }

  markCompleted(agentId: string, result: string): void {
    const e = this.agents.get(agentId);
    if (!e) return;
    if (e.status !== "running") return;
    e.status = "completed";
    e.result = result;
    e.finishedAt = Date.now();
    this.notify();
  }

  markFailed(agentId: string, error: string): void {
    const e = this.agents.get(agentId);
    if (!e) return;
    if (e.status !== "running") return;
    e.status = "failed";
    e.error = error;
    e.finishedAt = Date.now();
    this.notify();
  }

  cancel(agentId: string): boolean {
    const e = this.agents.get(agentId);
    if (!e) return false;
    if (e.status !== "running") return false;
    try {
      e.abort();
    } catch {
      // ignore
    }
    e.status = "cancelled";
    e.finishedAt = Date.now();
    this.notify();
    return true;
  }

  reset(): void {
    for (const e of this.agents.values()) {
      if (e.status === "running") {
        try {
          e.abort();
        } catch {
          // ignore
        }
      }
    }
    this.agents.clear();
    this.notify();
  }
}
```

- [ ] **Step 4: Run the tests, confirm all 5 pass**

Run: `bun test tests/tool-system/agent-registry-subscribe.test.ts`
Expected: 5/5 pass.

- [ ] **Step 5: Run the full test suite**

Run: `bun test`
Expected: no regressions.

- [ ] **Step 6: Commit**

```bash
git add src/tool-system/builtin/agent-registry.ts tests/tool-system/agent-registry-subscribe.test.ts
git commit -m "feat(agent-registry): subscribe/getSnapshot/hasRunning for useSyncExternalStore"
```

---

### Task 4.2: AgentDock component (TDD)

**Files:**
- Create: `src/ui/components/AgentDock.tsx`
- Test: `tests/ui/agent-dock.test.tsx`

- [ ] **Step 1: Verify the existing render-test harness**

Run: `head -10 tests/render-fixtures.ts` (file is at `tests/render-fixtures.ts`)

Expected: file exports `mount`, `dumpFrames`, `flush`. This is the pattern used by `tests/render-screen.test.ts`. We follow the same pattern.

- [ ] **Step 2: Write the failing test**

Create `tests/ui/agent-dock.test.tsx`:

```tsx
import { test, expect } from "bun:test";
import React from "react";
import { mount, dumpFrames, flush } from "../render-fixtures";
import { AgentDock } from "../../src/ui/components/AgentDock.js";
import { asyncAgentRegistry } from "../../src/tool-system/builtin/agent-registry.js";

function reset() {
  asyncAgentRegistry.reset();
}

test("no agents → dock renders nothing", async () => {
  reset();
  const h = mount(React.createElement(AgentDock));
  await flush();
  const out = dumpFrames(h);
  // null render → no agent-specific markers in the frame
  expect(out).not.toContain("agents:");
  h.unmount();
});

test("one running agent → renders [1] description", async () => {
  reset();
  asyncAgentRegistry.register({
    agentId: "abc",
    description: "review module",
    status: "running",
    startedAt: Date.now(),
    abort: () => {},
  });
  const h = mount(React.createElement(AgentDock));
  await flush();
  const out = dumpFrames(h);
  expect(out).toContain("[1]");
  expect(out).toContain("review module");
  expect(out).toContain("agents:");
  h.unmount();
});

test("completed agent → not in dock", async () => {
  reset();
  asyncAgentRegistry.register({
    agentId: "abc",
    description: "review module",
    status: "running",
    startedAt: Date.now(),
    abort: () => {},
  });
  asyncAgentRegistry.markCompleted("abc", "done");
  const h = mount(React.createElement(AgentDock));
  await flush();
  const out = dumpFrames(h);
  expect(out).not.toContain("review module");
  h.unmount();
});

test("more than 5 agents → shows '+N more' indicator", async () => {
  reset();
  for (let i = 0; i < 7; i++) {
    asyncAgentRegistry.register({
      agentId: `a${i}`,
      description: `agent-${i}`,
      status: "running",
      startedAt: Date.now(),
      abort: () => {},
    });
  }
  const h = mount(React.createElement(AgentDock));
  await flush();
  const out = dumpFrames(h);
  expect(out).toContain("[5]");
  expect(out).toContain("+2 more");
  h.unmount();
});
```

Note the import uses `mount`/`dumpFrames`/`flush` from `tests/render-fixtures.ts` — the same pattern as `tests/render-screen.test.ts:5`.

- [ ] **Step 3: Run the test, confirm it fails**

Run: `bun test tests/ui/agent-dock.test.tsx`
Expected: failures — `AgentDock` not found.

- [ ] **Step 4: Implement `AgentDock`**

Create `src/ui/components/AgentDock.tsx`:

```tsx
import React, { useEffect, useState, useSyncExternalStore } from "react";
import { Box, Text } from "../../render/index.js";
import { asyncAgentRegistry } from "../../tool-system/builtin/agent-registry.js";

const MAX_VISIBLE = 5;

export function AgentDock(): React.ReactElement | null {
  const agents = useSyncExternalStore(
    asyncAgentRegistry.subscribe,
    asyncAgentRegistry.getSnapshot,
  );
  const running = agents.filter((a) => a.status === "running");

  // 1 Hz local tick to refresh elapsed-time text. Only runs while there are
  // running agents — keeps idle frame writes at zero. forceUpdate via useState
  // is scoped to AgentDock's reconciler subtree; the rest of the app does not
  // re-render.
  const [, tick] = useState(0);
  useEffect(() => {
    if (running.length === 0) return;
    const id = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [running.length === 0]);

  if (running.length === 0) return null;

  const visible = running.slice(0, MAX_VISIBLE);
  const overflow = running.length - visible.length;
  const now = Date.now();

  return (
    <Box flexDirection="row" gap={1} paddingX={1}>
      <Text dim>agents:</Text>
      {visible.map((a, i) => {
        const elapsedSec = Math.floor((now - a.startedAt) / 1000);
        return (
          <Text key={a.agentId} color="ansi:cyan">
            [{i + 1}] {a.description} {elapsedSec}s
          </Text>
        );
      })}
      {overflow > 0 && <Text dim>+{overflow} more</Text>}
    </Box>
  );
}
```

- [ ] **Step 5: Run the tests, confirm all 4 pass**

Run: `bun test tests/ui/agent-dock.test.tsx`
Expected: 4/4 pass.

- [ ] **Step 6: Mount AgentDock above the input in App.tsx**

Open `src/ui/App.tsx`. Find the `FullscreenLayout` invocation (search for `<FullscreenLayout` or `bottom=`). Locate where the input box is rendered in the `bottom` slot.

Replace the `bottom` prop value:

```tsx
bottom={<InputBox ... />}
```

with:

```tsx
bottom={
  <>
    <AgentDock />
    <InputBox ... />
  </>
}
```

Add the import at the top:

```tsx
import { AgentDock } from "./components/AgentDock.js";
```

- [ ] **Step 7: Update `isRunning` derivation**

In `src/ui/App.tsx`, find the line set in Task 2.2 Step 1:

```tsx
const isRunning = isQueryActive;
```

Replace with:

```tsx
const hasRunningBgAgents = useSyncExternalStore(
  asyncAgentRegistry.subscribe,
  asyncAgentRegistry.hasRunning,
);
const isRunning = isQueryActive || hasRunningBgAgents;
```

Add the import:

```tsx
import { asyncAgentRegistry } from "../tool-system/builtin/agent-registry.js";
```

- [ ] **Step 8: Typecheck + test**

Run: `bun run typecheck && bun test`
Expected: clean.

- [ ] **Step 9: Manual smoke**

Run: `bun run dev`. In the codeshell UI, send a prompt that asks the model to call `Agent(run_in_background=true, ...)` (or hand-construct one if you have a debug entry point).

Expected: the dock appears between the transcript and the input box, showing the agent. Elapsed time updates every second.

- [ ] **Step 10: Commit**

```bash
git add src/ui/components/AgentDock.tsx tests/ui/agent-dock.test.tsx src/ui/App.tsx
git commit -m "feat(ui): AgentDock surfaces background sub-agents with elapsed timer"
```

**Phase 4 complete.**

---

## Phase 5 — Per-Agent Transcript + Ctrl-Digit View Switching (P3 part 2, 1.5 day)

### Task 5.1: Add `transcript` field to AsyncAgentEntry

**Files:**
- Modify: `src/tool-system/builtin/agent-registry.ts`
- Test: extend `tests/tool-system/agent-registry-subscribe.test.ts` (existing file)

- [ ] **Step 1: Write the failing test**

Append to `tests/tool-system/agent-registry-subscribe.test.ts`:

```ts
test("appendToTranscript stores entries on the agent and notifies", () => {
  asyncAgentRegistry.reset();
  asyncAgentRegistry.register({
    agentId: "a1",
    description: "x",
    status: "running",
    startedAt: Date.now(),
    abort: () => {},
  });
  const cb = mock(() => {});
  asyncAgentRegistry.subscribe(cb);
  asyncAgentRegistry.appendToTranscript("a1", {
    id: "t1",
    type: "assistant_text",
    text: "agent thinking",
    streaming: false,
  } as any);
  const e = asyncAgentRegistry.get("a1");
  expect(e?.transcript?.length).toBe(1);
  expect(cb).toHaveBeenCalledTimes(1);
});

test("appendToTranscript on unknown agent is a no-op", () => {
  asyncAgentRegistry.reset();
  expect(() =>
    asyncAgentRegistry.appendToTranscript("ghost", { id: "x" } as any),
  ).not.toThrow();
});
```

- [ ] **Step 2: Run the test, confirm it fails**

Run: `bun test tests/tool-system/agent-registry-subscribe.test.ts`
Expected: failures — `appendToTranscript` not defined, `transcript` field missing.

- [ ] **Step 3: Extend `AsyncAgentEntry` and add `appendToTranscript`**

Open `src/tool-system/builtin/agent-registry.ts`. At the top of the file, add an import (or local type) for `ChatEntry`:

```ts
import type { ChatEntry } from "../../ui/store.js";
```

Note: this introduces a `tool-system → ui` import. If this direction is forbidden by your dependency rules, instead define a minimal `AgentTranscriptEntry` type local to `agent-registry.ts` that's structurally compatible with `ChatEntry`:

```ts
export interface AgentTranscriptEntry {
  id: string;
  type: string;
  [key: string]: unknown;
}
```

Then update `AsyncAgentEntry`:

```ts
export interface AsyncAgentEntry {
  agentId: string;
  description: string;
  status: AsyncAgentStatus;
  startedAt: number;
  finishedAt?: number;
  result?: string;
  error?: string;
  abort: () => void;
  transcript?: AgentTranscriptEntry[]; // populated for run_in_background agents
}
```

Add the method:

```ts
appendToTranscript(agentId: string, entry: AgentTranscriptEntry): void {
  const e = this.agents.get(agentId);
  if (!e) return;
  if (!e.transcript) e.transcript = [];
  e.transcript.push(entry);
  this.notify();
}
```

- [ ] **Step 4: Run the tests, confirm they pass**

Run: `bun test tests/tool-system/agent-registry-subscribe.test.ts`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/tool-system/builtin/agent-registry.ts tests/tool-system/agent-registry-subscribe.test.ts
git commit -m "feat(agent-registry): per-agent transcript + appendToTranscript"
```

---

### Task 5.2: Plumb agent stream events into transcript

**Files:**
- Modify: `src/tool-system/builtin/agent.ts` (background branch only)

- [ ] **Step 1: Understand the current stream callback**

Read `src/tool-system/builtin/agent.ts:60-80` and `src/tool-system/context.ts` (around the `SubAgentSpawner` definition).

`spawner.spawn(opts)` returns the final text. Stream events are routed through `spawner.parentStream` callback. For background mode, we want a **second** stream sink that writes into the agent's own transcript.

- [ ] **Step 2: Modify the background branch to wrap parentStream**

In `src/tool-system/builtin/agent.ts`, locate the background path (around lines 110-135). The current call is:

```ts
void runSubAgent(spawner, {
  agentId,
  description,
  prompt,
  maxTurns,
  signal: controller.signal,
})
```

`runSubAgent` reads `spawner.parentStream` directly. For background, we want the agent's events to *also* land in the registry transcript, but **not** in the parent transcript (the parent already got the "agent launched" placeholder). Solution: temporarily replace `spawner.parentStream` for this call.

Replace the background branch with:

```ts
if (runInBackground) {
  const controller = new AbortController();
  asyncAgentRegistry.register({
    agentId,
    description,
    status: "running",
    startedAt: Date.now(),
    abort: () => controller.abort(),
  });

  // Re-route stream events into the agent's own transcript, not the parent's.
  const transcriptSink: StreamCallback = (event) => {
    // Translate provider stream events into agent transcript entries.
    // Minimal mapping — preserve raw type so the UI can render any kind.
    asyncAgentRegistry.appendToTranscript(agentId, {
      id: `bg-${agentId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      type: event.type,
      ...event,
    } as any);
  };

  const bgSpawner: SubAgentSpawner = {
    ...spawner,
    parentStream: transcriptSink, // override only for the background run
  };

  void runSubAgent(bgSpawner, {
    agentId,
    description,
    prompt,
    maxTurns,
    signal: controller.signal,
  })
    .then((text) => asyncAgentRegistry.markCompleted(agentId, text))
    .catch((err: Error) => {
      if (controller.signal.aborted) return;
      asyncAgentRegistry.markFailed(agentId, err.message);
    });

  return [
    `Agent launched in background.`,
    `agent_id: ${agentId}`,
    `description: ${description}`,
    ``,
    `Use AgentStatus(agent_id="${agentId}") to check progress or fetch the result.`,
    `Use AgentCancel(agent_id="${agentId}") to stop it.`,
  ].join("\n");
}
```

- [ ] **Step 2.5: Typecheck**

Run: `bun run typecheck`
Expected: clean. If errors mention `SubAgentSpawner` not being assignable, add a structural cast or extend the interface to allow partial overrides.

- [ ] **Step 3: Verify no existing test regresses**

Run: `bun test`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add src/tool-system/builtin/agent.ts
git commit -m "feat(agent): route background-agent stream events into per-agent transcript"
```

---

### Task 5.3: View-mode state + Ctrl-digit switching

**Files:**
- Modify: `src/ui/App.tsx`
- Modify: `src/ui/components/VirtualMessageList.tsx` (only if its data source needs to be parameterized)
- Test: `tests/ui/agent-view-switching.test.ts`

- [ ] **Step 1: Add `viewMode` state to App**

Open `src/ui/App.tsx`. After the existing chatStore subscription (search for `chatStore.getEntries` or the `useSyncExternalStore` call that backs the transcript), add:

```tsx
type ViewMode = { kind: "main" } | { kind: "agent"; agentId: string };
const [viewMode, setViewMode] = useState<ViewMode>({ kind: "main" });
```

- [ ] **Step 2: Derive transcript-to-render from viewMode**

Find where the main transcript is passed to `VirtualMessageList`. The pattern looks like:

```tsx
const entries = useSyncExternalStore(chatStore.subscribe, chatStore.getEntries);
// ...
<VirtualMessageList entries={entries} ... />
```

Modify to:

```tsx
const mainEntries = useSyncExternalStore(chatStore.subscribe, chatStore.getEntries);
const agents = useSyncExternalStore(
  asyncAgentRegistry.subscribe,
  asyncAgentRegistry.getSnapshot,
);

const entries = (() => {
  if (viewMode.kind === "main") return mainEntries;
  const agent = agents.find((a) => a.agentId === viewMode.agentId);
  return (agent?.transcript ?? []) as ChatEntry[];
})();

// Pass `entries` to VirtualMessageList unchanged.
```

If the selected agent doesn't exist (e.g., it just got cleared), fall back to main view: after the lookup, add:

```tsx
useEffect(() => {
  if (viewMode.kind === "agent") {
    const exists = agents.some((a) => a.agentId === viewMode.agentId);
    if (!exists) setViewMode({ kind: "main" });
  }
}, [agents, viewMode]);
```

- [ ] **Step 3: Bind Ctrl-1..Ctrl-5 and Ctrl-0**

In the existing `useInput` handler (around line 723-820 in App.tsx), add a new branch BEFORE the existing keys are dispatched (so dock switching isn't blocked by isRunning):

```tsx
// Ctrl-0 → back to main; Ctrl-1..5 → switch to nth running bg agent
if (key.ctrl && ch && ch >= "0" && ch <= "5") {
  const n = parseInt(ch, 10);
  if (n === 0) {
    setViewMode({ kind: "main" });
    return;
  }
  const running = asyncAgentRegistry.getSnapshot().filter((a) => a.status === "running");
  const target = running[n - 1];
  if (target) {
    setViewMode({ kind: "agent", agentId: target.agentId });
  }
  return;
}
```

- [ ] **Step 4: Show current view in the dock**

Open `src/ui/components/AgentDock.tsx`. Accept a `viewMode` prop and highlight the active entry. Update its signature:

```tsx
export interface AgentDockProps {
  viewMode?: { kind: "main" } | { kind: "agent"; agentId: string };
}

export function AgentDock({ viewMode = { kind: "main" } }: AgentDockProps): React.ReactElement | null {
  // ... existing subscribe and tick logic ...
  const isActive = (a: AsyncAgentEntry) =>
    viewMode.kind === "agent" && viewMode.agentId === a.agentId;

  return (
    <Box flexDirection="row" gap={1} paddingX={1}>
      <Text dim>agents:</Text>
      {visible.map((a, i) => {
        const elapsedSec = Math.floor((now - a.startedAt) / 1000);
        const active = isActive(a);
        return (
          <Text
            key={a.agentId}
            color={active ? "ansi:cyanBright" : "ansi:cyan"}
            bold={active}
          >
            [{i + 1}] {a.description} {elapsedSec}s
          </Text>
        );
      })}
      {overflow > 0 && <Text dim>+{overflow} more</Text>}
      {viewMode.kind === "agent" && <Text dim>(Ctrl-0 to return)</Text>}
    </Box>
  );
}
```

Import `AsyncAgentEntry` from the registry at the top.

Pass the prop from App.tsx:

```tsx
<AgentDock viewMode={viewMode} />
```

- [ ] **Step 5: Write the integration test**

Create `tests/ui/agent-view-switching.test.ts`:

```ts
import { test, expect } from "bun:test";
import { asyncAgentRegistry } from "../../src/tool-system/builtin/agent-registry.js";

function reset() {
  asyncAgentRegistry.reset();
}

test("appendToTranscript on running agent populates view-source", () => {
  reset();
  asyncAgentRegistry.register({
    agentId: "a1",
    description: "x",
    status: "running",
    startedAt: Date.now(),
    abort: () => {},
  });
  asyncAgentRegistry.appendToTranscript("a1", {
    id: "t1",
    type: "assistant_text",
    text: "hello from background agent",
  } as any);
  const snap = asyncAgentRegistry.getSnapshot();
  const a = snap.find((x) => x.agentId === "a1");
  expect(a?.transcript?.length).toBe(1);
  expect((a?.transcript?.[0] as any)?.text).toContain("hello from background");
});

test("getSnapshot identity changes when transcript appended", () => {
  reset();
  asyncAgentRegistry.register({
    agentId: "a1",
    description: "x",
    status: "running",
    startedAt: Date.now(),
    abort: () => {},
  });
  const before = asyncAgentRegistry.getSnapshot();
  asyncAgentRegistry.appendToTranscript("a1", { id: "t1", type: "user" } as any);
  const after = asyncAgentRegistry.getSnapshot();
  expect(before).not.toBe(after);
});
```

- [ ] **Step 6: Run tests + typecheck**

Run: `bun run typecheck && bun test`
Expected: clean.

- [ ] **Step 7: Manual acceptance**

Run: `bun run dev`. Trigger a background agent (e.g. via a prompt that asks the model to call `Agent(run_in_background=true, ...)`).

Acceptance steps:
1. Dock shows `[1] description Xs`.
2. Press Ctrl-1: transcript area swaps to the agent's transcript. Dock entry bolds. "(Ctrl-0 to return)" hint appears.
3. Press Ctrl-0: returns to main transcript.
4. Wait for agent to complete: dock entry disappears; if you were viewing it, view auto-returns to main (the useEffect from Step 2).

- [ ] **Step 8: Commit**

```bash
git add src/ui/App.tsx src/ui/components/AgentDock.tsx tests/ui/agent-view-switching.test.ts
git commit -m "feat(ui): Ctrl-digit switches transcript view between main and bg-agent"
```

**Phase 5 complete.**

---

## Final Phase: Regression + Bench + Docs

### Task 6.1: Full regression sweep

- [ ] **Step 1: Run full test suite**

Run: `bun test`
Expected: all green.

- [ ] **Step 2: Run typecheck**

Run: `bun run typecheck`
Expected: no errors.

- [ ] **Step 3: Run render benches and compare against baseline**

Run: `bun run bench:render`
Expected: no benchmark regresses more than 5 % vs. previous baseline. If any does, dig in before merging.

- [ ] **Step 4: Commit any baseline updates if benches were tightened/loosened intentionally**

```bash
git add bench/baselines/  # or wherever baselines are stored
git commit -m "bench(render): update baselines after llm/ui decoupling"
```

### Task 6.2: Update CLAUDE.md / docs index

- [ ] **Step 1: Add an entry to the architecture index**

If `docs/architecture/README.md` lists features, add a one-liner:

> - LLM/UI decoupling: stream watchdog + QueryGuard + abort preservation + agent dock. See [spec](../superpowers/specs/2026-05-17-llm-ui-decoupling-design.md), [plan](../superpowers/plans/2026-05-17-llm-ui-decoupling.md).

- [ ] **Step 2: Commit**

```bash
git add docs/architecture/README.md
git commit -m "docs: index llm/ui decoupling spec + plan"
```

**Implementation complete.**

---

## Open Items After Implementation

These are explicit follow-ups not in scope of this plan:

1. **Anthropic provider watchdog** — only ship if a freeze is observed against anthropic upstream. Phase 1 wrapper is generalizable; copy-paste with provider-specific chunk shape.
2. **Mouse-click dock switching** — semantic ambiguity in TUI; punt.
3. **Cross-process agent persistence** — out of scope by design.
4. **`stallCount`-style stall-gap telemetry** — CC has it; we don't need it until we have a slowness (not deadlock) problem.

---

## Self-Review Notes

Plan written 2026-05-17 against spec `2026-05-17-llm-ui-decoupling-design.md`.

Spec sections mapped:
- §5 Layer 1 → Phase 1 (Tasks 1.1, 1.2, 1.3, 1.4)
- §6 Layer 2 → Phase 2 (Tasks 2.1, 2.2)
- §7 Layer 3 → Phase 4 Step 7 (folded into AgentDock task)
- §8 Layer 4 → Phase 3 (Tasks 3.1, 3.2, 3.3)
- §9 P3 base → Phase 4 (Tasks 4.1, 4.2)
- §9 P3 full → Phase 5 (Tasks 5.1, 5.2, 5.3)
- §10 Test strategy → distributed per task
- §11 Implementation order → matches phase order
- §12 Risks → addressed inline (Pre-Flight PF-1 covers useSyncExternalStore on bun; watchdog is env-gated; dock timer uses local forceUpdate not useSyncExternalStore-on-time)
- §13 Out-of-scope → re-stated in "Open Items After Implementation"
- §14 Open questions → resolved in Pre-Flight (PF-3 confirms engine does not write transcript on AbortError)
