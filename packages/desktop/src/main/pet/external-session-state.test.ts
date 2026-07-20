import { describe, expect, test } from "bun:test";
import {
  decayExternalActivity,
  reduceExternalTail,
  seedExternalActivity,
} from "./external-session-state";

describe("reduceExternalTail", () => {
  test("tool events set running/tool with toolName; tool_result keeps it", () => {
    let a = reduceExternalTail(undefined, [{ type: "tool", name: "Bash", summary: "ls" }], 1_000);
    expect(a).toEqual({ runState: "running", phase: "tool", toolName: "Bash", lastEventAt: 1_000 });
    a = reduceExternalTail(a, [{ type: "tool_result", result: "ok", isError: false }], 2_000);
    expect(a.phase).toBe("tool");
    expect(a.toolName).toBe("Bash");
    expect(a.lastEventAt).toBe(2_000);
  });

  test("user/assistant → running/model; turn_end → idle without phase", () => {
    let a = reduceExternalTail(undefined, [{ type: "user", text: "hi" }], 1_000);
    expect(a).toEqual({ runState: "running", phase: "model", lastEventAt: 1_000 });
    a = reduceExternalTail(a, [{ type: "assistant", text: "done" }], 2_000);
    expect(a.phase).toBe("model");
    a = reduceExternalTail(a, [{ type: "turn_end", reason: "end_turn" }], 3_000);
    expect(a).toEqual({ runState: "idle", lastEventAt: 3_000 });
  });

  test("empty batch keeps previous state", () => {
    const prev = { runState: "running" as const, phase: "model" as const, lastEventAt: 1_000 };
    expect(reduceExternalTail(prev, [], 9_000)).toBe(prev);
  });

  test("folds a multi-event batch in one call", () => {
    const a = reduceExternalTail(
      undefined,
      [
        { type: "tool", name: "Bash", summary: "ls" },
        { type: "tool_result", result: "ok", isError: false },
        { type: "turn_end", reason: "end_turn" },
      ],
      5_000,
    );
    expect(a).toEqual({ runState: "idle", lastEventAt: 5_000 });
  });

  test("tool_result with no preceding tool yields running without phase", () => {
    const a = reduceExternalTail(
      undefined,
      [{ type: "tool_result", result: "ok", isError: false }],
      5_000,
    );
    expect(a).toEqual({ runState: "running", lastEventAt: 5_000 });
  });
});

describe("seedExternalActivity / decayExternalActivity", () => {
  test("recent mtime seeds running, stale mtime seeds idle", () => {
    expect(seedExternalActivity(9_500, 10_000, 90_000).runState).toBe("running");
    expect(seedExternalActivity(0, 200_000, 90_000).runState).toBe("idle");
  });

  test("running decays to idle after quietMs without events", () => {
    const running = {
      runState: "running" as const,
      phase: "tool" as const,
      toolName: "Bash",
      lastEventAt: 1_000,
    };
    expect(decayExternalActivity(running, 50_000, 90_000)).toBe(running);
    const decayed = decayExternalActivity(running, 100_000, 90_000);
    expect(decayed).toEqual({ runState: "idle", lastEventAt: 1_000 });
  });
});
