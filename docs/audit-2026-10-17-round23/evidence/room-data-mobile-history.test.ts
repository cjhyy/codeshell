import { describe, expect, test } from "bun:test";
import { buildSessionHistory } from "/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/packages/server/src/mobile-remote/mobile-history.ts";

describe("round23 actual mobile history leaf with owned readers", () => {
  test("forwards the selected session once and preserves empty history", async () => {
    const seen: string[] = [];
    const result = await buildSessionHistory("session-owned", async (sessionId) => {
      seen.push(sessionId);
      return [];
    });
    expect(seen).toEqual(["session-owned"]);
    expect(result).toEqual([]);
  });

  test("projects plain user text in the reader's order", async () => {
    const result = await buildSessionHistory("session-owned", async () => [
      { kind: "user", text: "first" },
      { kind: "user", text: "中文\nsecond" },
      { kind: "user", text: "third" },
    ]);
    expect(result).toEqual([
      { type: "user_message", text: "first" },
      { type: "user_message", text: "中文\nsecond" },
      { type: "user_message", text: "third" },
    ]);
  });

  test("preserves owned stream event objects without remapping their content", async () => {
    const first = { type: "text_delta", text: "answer" };
    const second = { type: "turn_complete", reason: "completed" };
    const result = await buildSessionHistory("session-owned", async () => [
      { kind: "stream", event: first },
      { kind: "stream", event: second },
    ]);
    expect(result).toEqual([first, second]);
    expect(result[0]).toBe(first);
    expect(result[1]).toBe(second);
  });

  test("keeps user and stream interleaving without mutating readonly input", async () => {
    const stream = Object.freeze({ type: "text_delta", text: "reply" });
    const items = Object.freeze([
      Object.freeze({ kind: "user", text: "question" }),
      Object.freeze({ kind: "stream", event: stream }),
      Object.freeze({ kind: "user", text: "follow up" }),
    ]);
    const before = JSON.stringify(items);
    const result = await buildSessionHistory("session-owned", async () => items);
    expect(result).toEqual([
      { type: "user_message", text: "question" },
      stream,
      { type: "user_message", text: "follow up" },
    ]);
    expect(JSON.stringify(items)).toBe(before);
    expect(result[1]).toBe(stream);
  });

  test("independent owned reader completions do not share output state", async () => {
    let resolveSlow!: (items: { kind: string; text: string }[]) => void;
    const slowItems = new Promise<{ kind: string; text: string }[]>((resolve) => {
      resolveSlow = resolve;
    });
    const seen: string[] = [];
    const slow = buildSessionHistory("slow-owned", (sessionId) => {
      seen.push(sessionId);
      return slowItems;
    });
    const fast = buildSessionHistory("fast-owned", async (sessionId) => {
      seen.push(sessionId);
      return [{ kind: "user", text: "fast" }];
    });
    expect(await fast).toEqual([{ type: "user_message", text: "fast" }]);
    resolveSlow([{ kind: "user", text: "slow" }]);
    expect(await slow).toEqual([{ type: "user_message", text: "slow" }]);
    expect(seen).toEqual(["slow-owned", "fast-owned"]);
  });

  test("an owned rejecting reader preserves the same error at the leaf boundary", async () => {
    const error = new Error("owned reader failed");
    await expect(
      buildSessionHistory("session-owned", async () => {
        throw error;
      }),
    ).rejects.toBe(error);
  });
});
