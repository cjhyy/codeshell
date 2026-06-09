import { test, expect } from "bun:test";
import { StreamIdleTimeoutError } from "../../packages/core/src/llm/stream-watchdog.js";

/**
 * Drive a tiny consumer that hangs after the first chunk. The watchdog
 * (with idleTimeoutMs=100) should fire and the consumer should reject
 * with StreamIdleTimeoutError.
 */
test("watchdog aborts the for-await when stream hangs after first chunk", async () => {
  process.env.CODESHELL_ENABLE_STREAM_WATCHDOG = "1";
  process.env.CODESHELL_STREAM_IDLE_TIMEOUT_MS = "100";

  const { runStreamWithWatchdog } = await import("../../packages/core/src/llm/providers/openai.js");

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

  const { runStreamWithWatchdog } = await import("../../packages/core/src/llm/providers/openai.js");
  const text = await runStreamWithWatchdog(fast() as any, { idleTimeoutMs: 100 });
  expect(text).toBe("abc");
});

test("fast path: aborted signal stops forwarding buffered chunks", async () => {
  delete process.env.CODESHELL_ENABLE_STREAM_WATCHDOG;
  const { runStreamWithWatchdog } = await import("../../packages/core/src/llm/providers/openai.js");

  const seen: string[] = [];
  const controller = new AbortController();
  // Generator with several buffered chunks; abort after the first is consumed.
  async function* buffered() {
    yield { choices: [{ delta: { content: "a" } }] };
    yield { choices: [{ delta: { content: "b" } }] };
    yield { choices: [{ delta: { content: "c" } }] };
  }
  await runStreamWithWatchdog(buffered() as any, {
    signal: controller.signal,
    onChunk: (chunk: any) => {
      const t = chunk?.choices?.[0]?.delta?.content ?? "";
      seen.push(t);
      controller.abort(); // abort right after the first chunk
      return t;
    },
  });
  // Only the first chunk should have been forwarded; b/c are dropped post-abort.
  expect(seen).toEqual(["a"]);
});

test("watchdog path: abort mid-await breaks out promptly", async () => {
  const { runStreamWithWatchdog } = await import("../../packages/core/src/llm/providers/openai.js");
  const controller = new AbortController();
  const seen: string[] = [];

  async function* slowThenHang() {
    yield { choices: [{ delta: { content: "first" } }] };
    await new Promise(() => {}); // hang — only the abort race can break this
  }

  // Abort 50ms in, while awaiting the (never-arriving) second chunk.
  setTimeout(() => controller.abort(), 50);

  const text = await runStreamWithWatchdog(slowThenHang() as any, {
    idleTimeoutMs: 5000, // long enough that the abort, not the watchdog, wins
    signal: controller.signal,
    onChunk: (chunk: any) => {
      const t = chunk?.choices?.[0]?.delta?.content ?? "";
      seen.push(t);
      return t;
    },
  });
  expect(seen).toEqual(["first"]);
  expect(text).toBe("first");
});

test("watchdog is dormant when explicitly opted out and caller does not override", async () => {
  // The watchdog is ON by default now (opt-OUT after we observed half-dead
  // sockets hang 15-33min). The fast path is taken only when the watchdog is
  // explicitly disabled (disableWatchdog) AND no idleTimeoutMs is passed.
  const { runStreamWithWatchdog } = await import("../../packages/core/src/llm/providers/openai.js");

  // Generator that yields one chunk, hangs 150ms, then yields another.
  // We verify correctness via a spy on Promise.race to confirm the fast
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

    // Watchdog explicitly disabled + no idleTimeoutMs → fast path.
    const text = await runStreamWithWatchdog(slow() as any, { disableWatchdog: true });
    expect(text).toBe("xy");
    // Fast path uses a plain for-await with no Promise.race.
    expect(raceCallCount).toBe(0);
  } finally {
    Promise.race = originalRace as typeof Promise.race;
  }
});
