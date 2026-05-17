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
