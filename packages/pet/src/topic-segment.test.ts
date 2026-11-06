import { describe, expect, test } from "bun:test";
import {
  shouldCloseForNewDay,
  shouldStartNewSegment,
  buildCarryoverBrief,
  buildWorkMemoryEntry,
} from "./topic-segment.js";

const HOUR = 60 * 60 * 1000;

describe("topic segment boundaries", () => {
  test("starts a new segment after the idle threshold", () => {
    expect(shouldStartNewSegment({ lastInteractionAt: 0, now: 13 * HOUR, idleMs: 12 * HOUR })).toBe(
      true,
    );
    expect(shouldStartNewSegment({ lastInteractionAt: 0, now: 11 * HOUR, idleMs: 12 * HOUR })).toBe(
      false,
    );
  });

  test("treats exactly the idle threshold as a boundary", () => {
    expect(shouldStartNewSegment({ lastInteractionAt: 0, now: 12 * HOUR, idleMs: 12 * HOUR })).toBe(
      true,
    );
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

describe("shouldCloseForNewDay", () => {
  const hour = 3_600_000;
  const day1Noon = new Date(2026, 10, 5, 12, 0, 0).getTime();
  const day2Morning = new Date(2026, 10, 6, 9, 0, 0).getTime();
  test("closes on the first turn of a new local day when the segment is old enough", () => {
    expect(
      shouldCloseForNewDay({
        lastInteractionAt: day1Noon,
        segmentStartedAt: day1Noon - 2 * hour,
        now: day2Morning,
        minSegmentMs: 6 * hour,
      }),
    ).toBe(true);
  });
  test("keeps a young segment open across midnight", () => {
    expect(
      shouldCloseForNewDay({
        lastInteractionAt: day1Noon,
        segmentStartedAt: day2Morning - hour,
        now: day2Morning,
        minSegmentMs: 6 * hour,
      }),
    ).toBe(false);
  });
  test("never closes within the same local day", () => {
    expect(
      shouldCloseForNewDay({
        lastInteractionAt: day1Noon,
        segmentStartedAt: day1Noon - 10 * hour,
        now: day1Noon + hour,
        minSegmentMs: 6 * hour,
      }),
    ).toBe(false);
  });
});
