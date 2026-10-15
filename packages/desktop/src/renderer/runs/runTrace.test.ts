import { describe, expect, test } from "bun:test";
import type { RunDetail, RunSummary } from "../../preload/types";
import { buildToolTraces, filterRunHistory, formatRunDuration, keyRunEvents } from "./runTrace";

const event = (
  type: string,
  eventId: string,
  toolCallId?: string,
): RunDetail["events"][number] => ({
  type,
  eventId,
  timestamp: 0,
  data: { toolCallId },
});

describe("run trace presentation", () => {
  test("results belong to their preceding invocation when a call ID is reused", () => {
    const traces = buildToolTraces([
      event("tool_result", "orphan", "reused"),
      event("tool_use", "first", "reused"),
      event("tool_result", "first-result", "reused"),
      event("tool_use", "second", "reused"),
      event("tool_result", "second-result", "reused"),
      event("tool_result", "duplicate-result", "reused"),
    ]);
    expect(traces.map(({ call, result }) => [call.eventId, result?.eventId])).toEqual([
      ["first", "first-result"],
      ["second", "second-result"],
    ]);
  });

  test("missing and blank IDs never associate unrelated tool payloads", () => {
    const traces = buildToolTraces([
      event("tool_use", "missing"),
      event("tool_use", "blank", " "),
      event("tool_result", "missing-result"),
      event("tool_result", "blank-result", " "),
      event("tool_use", "known", "a"),
      event("tool_result", "other-result", "b"),
    ]);
    expect(traces).toHaveLength(3);
    expect(traces.every((trace) => trace.result === undefined)).toBe(true);
  });

  test("interleaved calls retain distinct outputs and duplicate event IDs retain distinct keys", () => {
    const traces = buildToolTraces([
      event("tool_use", "duplicate", "a"),
      event("tool_use", "duplicate", "b"),
      event("tool_result", "b-result", "b"),
      event("tool_result", "a-result", "a"),
    ]);
    expect(traces.map((trace) => trace.result?.eventId)).toEqual(["a-result", "b-result"]);
    expect(new Set(traces.map((trace) => trace.key)).size).toBe(2);
  });

  test("appending events and sliding the trace window preserves disclosure identities", () => {
    const before = [event("run_started", "started"), event("tool_use", "call", "a")];
    const after = [before[1], event("tool_result", "result", "a")];
    expect(keyRunEvents(before)[1].key).toBe(keyRunEvents(after)[0].key);
    expect(buildToolTraces(before)[0].key).toBe(buildToolTraces(after)[0].key);
  });

  test("search includes history identity, working directory and all query terms", () => {
    const runs = [
      {
        runId: "a",
        objective: "Review code",
        summary: "测试成功",
        cwd: "/projects/Alpha",
        status: "completed",
      },
      {
        runId: "b",
        objective: "Review code",
        sessionId: "session-beta",
        cwd: "/projects/beta",
        status: "failed",
      },
    ] as RunSummary[];
    expect(filterRunHistory(runs, "all", "  ALPHA 测试  ").map((run) => run.runId)).toEqual(["a"]);
    expect(filterRunHistory(runs, "all", "session-beta").map((run) => run.runId)).toEqual(["b"]);
    expect(filterRunHistory(runs, "completed", "beta")).toEqual([]);
    expect(filterRunHistory(runs, "all", "   ")).toEqual(runs);
  });

  test("duration rounding carries seconds into minutes and rejects invalid durations", () => {
    expect(formatRunDuration(119_999)).toBe("2m 0s");
    expect(formatRunDuration(61_200)).toBe("1m 1s");
    expect(formatRunDuration(1_250)).toBe("1.3 s");
    for (const invalid of [null, -1, NaN, Infinity]) expect(formatRunDuration(invalid)).toBe("—");
  });
});
