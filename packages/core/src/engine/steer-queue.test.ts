import { describe, test, expect } from "bun:test";
import type { StreamEvent } from "../types.js";

/**
 * Step-gap steering — contract tests.
 *
 * The full splice-at-step-boundary behavior runs through the heavy TurnLoop +
 * Engine harness (same rationale as turn-loop.test.ts: a faithful fake would
 * test the mock). What we lock down cheaply here is the type-level contract the
 * implementation depends on, so a refactor that drops the event silently fails
 * to compile instead of silently dropping injected guidance.
 */
describe("steer-injection wiring contract", () => {
  test("StreamEvent union includes steer_injected with a text payload", () => {
    const ev: StreamEvent = { type: "steer_injected", text: "也看看收藏页" };
    expect(ev.type).toBe("steer_injected");
    // narrow to the member so a shape change (text → something else) breaks here
    if (ev.type === "steer_injected") {
      expect(ev.text).toBe("也看看收藏页");
    }
  });
});
