import { test, expect } from "bun:test";
import { StreamIdleTimeoutError } from "../../src/llm/stream-watchdog.js";

/**
 * Drive a tiny consumer that hangs after the first chunk. The watchdog
 * (with idleTimeoutMs=100) should fire and the consumer should reject
 * with StreamIdleTimeoutError.
 */
test("watchdog aborts the for-await when stream hangs after first chunk", async () => {
  process.env.CODESHELL_ENABLE_STREAM_WATCHDOG = "1";
  process.env.CODESHELL_STREAM_IDLE_TIMEOUT_MS = "100";

  const { runStreamWithWatchdog } = await import("../../src/llm/providers/openai.js");

  async function* hangAfterFirst() {
    yield { choices: [{ delta: { content: "hello" } }] };
    await new Promise(() => {}); // hang
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

test("watchdog is dormant when env flag is off and caller does not override", async () => {
  // Explicitly ensure the env flag is off.
  delete process.env.CODESHELL_ENABLE_STREAM_WATCHDOG;

  const { runStreamWithWatchdog } = await import("../../src/llm/providers/openai.js");

  // Generator that yields one chunk, hangs 150ms, then yields another.
  // With the default 90s timeout the watchdog would NOT fire regardless —
  // so we verify correctness via a spy on Promise.race to confirm the fast
  // path (no race) is actually taken.
  const originalRace = Promise.race.bind(Promise);
  let raceCallCount = 0;
  const raceSpy = (...args: Parameters<typeof Promise.race>) => {
    raceCallCount++;
    return originalRace(...args);
  };
  Promise.race = raceSpy as typeof Promise.race;

  try {
    async function* slow() {
      yield { choices: [{ delta: { content: "x" } }] };
      await new Promise((r) => setTimeout(r, 150));
      yield { choices: [{ delta: { content: "y" } }] };
    }

    // Caller does NOT pass idleTimeoutMs → fast path should be selected.
    const text = await runStreamWithWatchdog(slow() as any);
    expect(text).toBe("xy");
    // Fast path uses a plain for-await with no Promise.race.
    expect(raceCallCount).toBe(0);
  } finally {
    Promise.race = originalRace as typeof Promise.race;
  }
});
