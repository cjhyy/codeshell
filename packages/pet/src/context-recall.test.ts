import { describe, expect, test } from "bun:test";
import { selectPetMemories, type PetRecallMemory } from "./context-recall.js";

const fact = (id: string, text: string, updatedAt: number): PetRecallMemory => ({
  id,
  text,
  source: "user",
  updatedAt,
});

describe("goal-relevant Mimi memory selection", () => {
  test("recalls an old relevant fact beyond the recent window and retains recent fallback", () => {
    const entries = Array.from({ length: 40 }, (_, i) =>
      fact(`mem-${i}`, `色彩偏好 ${i}`, 100 + i),
    );
    entries.push(fact("mem-old", "Archive exports must use the original invoice checksum.", 1));
    const before = structuredClone(entries);
    const result = selectPetMemories(entries, { message: "Verify invoice exports checksum" });
    expect(result.memories[0]?.id).toBe("mem-old");
    expect(result.memories.some((entry) => entry.id === "mem-39")).toBe(true);
    expect(result.memoryWindow).toMatchObject({
      totalCount: 41,
      visibleCount: 24,
      matchedCount: 1,
      truncated: true,
      selection: "goal-relevance",
    });
    expect(entries).toEqual(before);
  });

  test("uses grounded Chinese objectives for short follow-ups without hiding other-source facts", () => {
    const entries = [
      fact("old", "招聘简历需要保留原始指标和来源", 1),
      fact("new", "偏好深色主题", 100),
    ];
    entries[0]!.originRef = { id: "origin-other", kind: "desktop", channel: "mimi" };
    const result = selectPetMemories(
      entries,
      {
        message: "继续",
        groundedObjectives: ["核查招聘简历的来源指标"],
        originRef: { id: "origin-current", kind: "im-gateway", channel: "wechat" },
      },
      { maxEntries: 1, recentCount: 0 },
    );
    expect(result.memories.map((entry) => entry.id)).toEqual(["old"]);
    expect(result.memories[0]?.text).toBe(entries[0]?.text);
  });

  test("task associations add recall relevance without treating near-identical facts as equivalent", () => {
    const entries = [
      fact("negative", "Do not publish version 12", 2),
      fact("positive", "Publish version 13", 1),
    ];
    entries[1]!.taskIds = ["task-original"];
    const result = selectPetMemories(
      entries,
      { message: "继续", taskIds: ["task-original"] },
      { maxEntries: 1, recentCount: 0 },
    );
    expect(result.memories).toEqual([entries[1]!]);
    expect(entries).toHaveLength(2);
  });

  test("enforces serialized character and item budgets, skips oversized facts without shortening them", () => {
    const entries = [
      fact("huge", "invoice ".repeat(300), 100),
      fact("small", "invoice original checksum", 1),
    ];
    const result = selectPetMemories(
      entries,
      { message: "invoice" },
      { maxChars: 250, maxEntries: 2 },
    );
    expect(result.memories.map((entry) => entry.id)).toEqual(["small"]);
    expect(JSON.stringify(result.memories).length).toBeLessThanOrEqual(250);
    expect(result.memoryWindow.truncated).toBe(true);
    expect(selectPetMemories(entries, { message: "invoice" }, { maxEntries: 0 }).memories).toEqual(
      [],
    );
  });

  test("ties are stable regardless of input iteration order", () => {
    const entries = [fact("a", "Release checksum", 1), fact("b", "Release checksum", 1)];
    expect(selectPetMemories(entries, { message: "release" })).toEqual(
      selectPetMemories([...entries].reverse(), { message: "release" }),
    );
  });
});
