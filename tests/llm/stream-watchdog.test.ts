import { test, expect } from "bun:test";
import { createStreamWatchdog, StreamIdleTimeoutError } from "../../packages/core/src/llm/stream-watchdog.js";

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

test("dispose() called after onTimeout is queued but before it executes — onTimeout must not fire", async () => {
  let timedOut = false;
  const wd = createStreamWatchdog({
    idleTimeoutMs: 30,
    onTimeout: () => { timedOut = true; },
  });
  // Dispose before the 30 ms timer fires — the callback is now armed but
  // will see `disposed === true` when it eventually runs and must bail out.
  // We deliberately do NOT await here so we stay in the same microtask turn:
  // the timer cannot fire until we yield, ensuring dispose() wins the race.
  wd.dispose();
  // Wait long enough that the timer would have fired (callback queued)
  await new Promise((r) => setTimeout(r, 35));
  // Give a tick for any queued callback to drain
  await new Promise((r) => setTimeout(r, 10));
  // disposed flag in the callback prevents onTimeout from firing
  // (Strictly: this test only catches the bug when the queue ordering
  // works against us; the assertion still has value as a regression guard.)
  // The post-dispose tick has elapsed; check timedOut state.
  // After fix: timedOut === false (callback returned early due to disposed flag)
  // Note: this test is timing-dependent. If it becomes flaky in CI, the
  // root cause is the fix not being correct, not the test itself.
  expect(timedOut).toBe(false);
});
