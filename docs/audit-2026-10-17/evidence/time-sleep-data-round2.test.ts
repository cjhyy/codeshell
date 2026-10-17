import { afterEach, beforeEach, expect, jest, test } from "bun:test";
import { sleepTool } from "../../../packages/core/src/tool-system/builtin/sleep.ts";

beforeEach(() => { jest.useFakeTimers({ now: 0 }); });
afterEach(() => { jest.clearAllTimers(); jest.useRealTimers(); });

test("observation: a sleep aborted after registration reports the full requested sleep as completed", async () => {
  const controller = new AbortController();
  const pending = sleepTool({ seconds: 300, __signal: controller.signal });
  expect(jest.getTimerCount()).toBe(1);
  controller.abort();
  const result = await pending;
  console.log(JSON.stringify({ observation: "sleep-abort-success-message", requestedSeconds: 300, fakeElapsedMs: 0, signalAborted: controller.signal.aborted, expected: "Sleep aborted.", actual: result, remainingTimers: jest.getTimerCount() }));
  expect(jest.getTimerCount()).toBe(0);
  expect(result).toBe("Slept for 300 seconds.");
});

test("control: normal fake completion reports the actual requested duration", async () => {
  const pending = sleepTool({ seconds: 2.5 });
  jest.advanceTimersByTime(2_500);
  expect(await pending).toBe("Slept for 2.5 seconds.");
  expect(jest.getTimerCount()).toBe(0);
});
