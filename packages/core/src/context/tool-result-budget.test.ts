import { describe, test, expect } from "bun:test";
import { applyToolResultBudget } from "./compaction.js";
import type { Message } from "../types.js";

// Regression: applyToolResultBudget estimated each truncated block as ~200
// chars (`remaining += 200`), but the real replacement is ~150 boilerplate +
// up to 500 preview ≈ 650+. The underestimate stops the truncation loop early,
// so the message can still exceed maxTotalChars (review-2026-05-30).

function msgWithResults(sizes: number[]): Message {
  return {
    role: "user",
    content: sizes.map((n, i) => ({
      type: "tool_result" as const,
      tool_use_id: `t${i}`,
      content: "x".repeat(n),
    })),
  } as unknown as Message;
}

function totalToolResultChars(m: Message): number {
  if (!Array.isArray(m.content)) return 0;
  return m.content
    .filter((b) => b.type === "tool_result" && typeof b.content === "string")
    .reduce((sum, b) => sum + (b.content as string).length, 0);
}

describe("applyToolResultBudget keeps total within budget", () => {
  test("truncates enough large blocks to reach the budget (no early stop)", () => {
    // 10 blocks × 2000 = 20000; budget 8000. Each block truncates to ~651, so
    // saving ~1349 each. The magic-200 estimate over-counted savings and
    // stopped after ~6 blocks (leaving total ≈ 6×651 + 4×2000 = 11906 > 8000).
    // Accurate accounting truncates until the real total is within budget.
    const [out] = applyToolResultBudget([msgWithResults(Array(10).fill(2000))], 8000);
    expect(totalToolResultChars(out)).toBeLessThanOrEqual(8000);
  });

  test("when even full truncation can't reach budget, it still minimizes", () => {
    // 10 × 2000 = 20000; budget 3000. Floor is 10 × ~651 = 6510 (can't go
    // lower). Assert it truncated everything possible — total < original.
    const input = msgWithResults(Array(10).fill(2000));
    const [out] = applyToolResultBudget([input], 3000);
    expect(totalToolResultChars(out)).toBeLessThan(totalToolResultChars(input));
    expect(totalToolResultChars(out)).toBeLessThanOrEqual(7000); // ~6510 floor
  });

  test("does not 'truncate' a block when the replacement would be larger", () => {
    // A single 300-char block over a tiny budget: the ~650 replacement is
    // bigger, so the block must be left as-is rather than grown.
    const input = msgWithResults([300]);
    const [out] = applyToolResultBudget([input], 100);
    expect(out).toEqual(input);
  });

  test("leaves a within-budget message untouched", () => {
    const input = msgWithResults([100, 100]);
    const [out] = applyToolResultBudget([input], 3000);
    expect(out).toEqual(input);
  });
});
