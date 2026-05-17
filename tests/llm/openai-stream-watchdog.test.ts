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
