import { test, expect } from "bun:test";
import { StreamIdleTimeoutError } from "../../src/llm/stream-watchdog.js";
import { isRetryable } from "../../src/llm/retry.js";

test("StreamIdleTimeoutError is retryable", () => {
  const err = new StreamIdleTimeoutError(90000, "req_x");
  expect(isRetryable(err)).toBe(true);
});

test("AbortError (user cancel) is NOT retryable", () => {
  const abortErr = new Error("aborted");
  abortErr.name = "AbortError";
  expect(isRetryable(abortErr)).toBe(false);
});

test("generic Error is NOT retryable", () => {
  expect(isRetryable(new Error("boom"))).toBe(false);
});
