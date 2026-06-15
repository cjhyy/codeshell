/**
 * Tests for resolveStopBucket — which conversation the composer Stop button
 * cancels. Regression target: with two concurrent conversations, viewing #2 and
 * pressing Stop must abort #2 (the ACTIVE one), never #1 (whichever happened to
 * send last and own the global runningBucket ref).
 */
import { describe, test, expect } from "bun:test";
import { resolveStopBucket } from "./stopRouting";

describe("resolveStopBucket", () => {
  test("explicit override always wins", () => {
    expect(
      resolveStopBucket("repo::override", "repo::active", "repo::running"),
    ).toBe("repo::override");
  });

  test("no override → uses activeBucket (the conversation the user is viewing)", () => {
    // The composer Stop button is only visible when the ACTIVE bucket is busy
    // (busy = busyKeys.has(activeBucket)), so its intent is always the active one.
    expect(resolveStopBucket(undefined, "repo::active", "repo::running")).toBe(
      "repo::active",
    );
  });

  test("REGRESSION: two concurrent convos — stop targets the viewed one, not the last-sent", () => {
    // #1 sent first, then #2 sent (runningBucketRef = #2). User switches BACK to
    // view #1 (activeBucket = #1) and presses Stop. Must stop #1, not #2.
    const active = "repo::convo-1";
    const running = "repo::convo-2"; // last send overwrote the global ref
    expect(resolveStopBucket(undefined, active, running)).toBe(active);
  });

  test("falls back to runningBucket only when there is no active bucket", () => {
    expect(resolveStopBucket(undefined, null, "repo::running")).toBe(
      "repo::running",
    );
  });

  test("returns null when nothing is resolvable", () => {
    expect(resolveStopBucket(undefined, null, null)).toBeNull();
  });
});
