import { describe, expect, test } from "bun:test";
import { runBatchUpdate, summarizeBatch } from "./applyUpdates";

describe("runBatchUpdate", () => {
  test("runs every id sequentially and collects outcomes", async () => {
    const order: string[] = [];
    const outcomes = await runBatchUpdate(
      ["a", "b", "c"],
      (id) => `name-${id}`,
      async (id) => {
        order.push(id);
        return { updated: id !== "b", reason: id === "b" ? "already up to date" : undefined };
      },
    );
    expect(order).toEqual(["a", "b", "c"]); // sequential
    expect(outcomes.map((o) => o.updated)).toEqual([true, false, true]);
    expect(outcomes[0]!.label).toBe("name-a");
  });

  test("a per-item failure becomes error outcome, not a throw — rest still run", async () => {
    const seen: string[] = [];
    const outcomes = await runBatchUpdate(
      ["a", "boom", "c"],
      (id) => id,
      async (id) => {
        seen.push(id);
        if (id === "boom") throw new Error("network down");
        return { updated: true };
      },
    );
    expect(seen).toEqual(["a", "boom", "c"]); // c still ran after boom failed
    expect(outcomes[1]).toMatchObject({ id: "boom", error: true, reason: "network down", updated: false });
  });

  test("empty list → empty outcomes", async () => {
    expect(await runBatchUpdate([], (x) => x, async () => ({ updated: true }))).toEqual([]);
  });
});

describe("summarizeBatch", () => {
  test("all updated", () => {
    const s = summarizeBatch([
      { id: "a", label: "a", updated: true },
      { id: "b", label: "b", updated: true },
    ]);
    expect(s).toEqual({ message: "已更新 2 个", ok: true });
  });

  test("mixed updated / noop / failed", () => {
    const s = summarizeBatch([
      { id: "a", label: "a", updated: true },
      { id: "b", label: "b", updated: false, reason: "up to date" },
      { id: "c", label: "c", updated: false, error: true, reason: "boom" },
    ]);
    expect(s.message).toBe("已更新 1 个，1 个已是最新，1 个失败");
    expect(s.ok).toBe(false);
  });

  test("empty → 没有可更新项", () => {
    expect(summarizeBatch([])).toEqual({ message: "没有可更新项", ok: true });
  });
});
