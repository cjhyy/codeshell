import { describe, expect, test } from "bun:test";
import { shouldStartNewSegment, buildCarryoverBrief, buildWorkMemoryEntry } from "./topic-segment.js";

const HOUR = 60 * 60 * 1000;

describe("topic segment boundaries", () => {
  test("starts a new segment after the idle threshold", () => {
    expect(shouldStartNewSegment({ lastInteractionAt: 0, now: 13 * HOUR, idleMs: 12 * HOUR })).toBe(true);
    expect(shouldStartNewSegment({ lastInteractionAt: 0, now: 11 * HOUR, idleMs: 12 * HOUR })).toBe(false);
  });

  test("treats exactly the idle threshold as a boundary", () => {
    expect(shouldStartNewSegment({ lastInteractionAt: 0, now: 12 * HOUR, idleMs: 12 * HOUR })).toBe(true);
  });

  test("carryover brief includes unfinished tasks and latest conclusions", () => {
    const brief = buildCarryoverBrief({
      unfinished: [{ objective: "重构 X", workspace: "alpha" }],
      conclusions: ["修好了登录 bug"],
    });
    expect(brief).toContain("重构 X");
    expect(brief).toContain("alpha");
    expect(brief).toContain("修好了登录 bug");
  });

  test("carryover brief is empty when there is nothing to carry", () => {
    expect(buildCarryoverBrief({ unfinished: [], conclusions: [] })).toBe("");
  });

  test("carryover brief omits the workspace suffix when absent", () => {
    const brief = buildCarryoverBrief({
      unfinished: [{ objective: "无空间任务" }],
      conclusions: [],
    });
    expect(brief).toContain("无空间任务");
    expect(brief).not.toContain("(");
  });

  test("work memory entry captures task, outcome and refs", () => {
    const entry = buildWorkMemoryEntry({
      segmentId: "seg-1",
      objective: "修登录",
      outcome: "completed",
      workspace: "alpha",
      sessionRef: "sess-9",
      at: 42,
    });
    expect(entry).toMatchObject({
      segmentId: "seg-1",
      objective: "修登录",
      outcome: "completed",
      workspace: "alpha",
      sessionRef: "sess-9",
      at: 42,
    });
  });

  test("work memory entry is a defensive copy", () => {
    const input = {
      segmentId: "seg-2",
      objective: "调查",
      outcome: "pending-decided" as const,
      at: 7,
    };
    const entry = buildWorkMemoryEntry(input);
    expect(entry).not.toBe(input);
    expect(entry).toEqual(input);
  });
});
