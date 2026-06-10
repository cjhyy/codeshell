import { test, expect } from "bun:test";
import { basename, relativeTime, groupByProject } from "./format";

test("groupByProject 按 cwd 分组,最新项目在前,无项目沉底", () => {
  const items = [
    { id: "a", cwd: "/u/proj1", updatedAt: 100 },
    { id: "b", cwd: "/u/proj2", updatedAt: 300 },
    { id: "c", cwd: "/u/proj1", updatedAt: 200 },
    { id: "d", cwd: "", updatedAt: 999 }, // 无项目,即便最新也沉底
  ];
  const groups = groupByProject(items);
  expect(groups.map((g) => g.name)).toEqual(["proj2", "proj1", "无项目"]);
  // proj1 组里两条都在
  const p1 = groups.find((g) => g.name === "proj1")!;
  expect(p1.items.map((i) => i.id).sort()).toEqual(["a", "c"]);
  // 组的 updatedAt = 组内最新
  expect(p1.updatedAt).toBe(200);
});

test("groupByProject 空数组 → 空", () => {
  expect(groupByProject([])).toEqual([]);
});

test("basename 取最后一段,处理尾斜杠与反斜杠", () => {
  expect(basename("/Users/x/proj")).toBe("proj");
  expect(basename("/Users/x/proj/")).toBe("proj");
  expect(basename("C:\\repos\\app")).toBe("app");
  expect(basename("")).toBe("");
});

test("relativeTime 分档", () => {
  const now = 1_000_000_000_000;
  expect(relativeTime(now - 5_000, now)).toBe("刚刚");
  expect(relativeTime(now - 5 * 60_000, now)).toBe("5 分钟前");
  expect(relativeTime(now - 3 * 3600_000, now)).toBe("3 小时前");
  expect(relativeTime(now - 2 * 86400_000, now)).toBe("2 天前");
  expect(relativeTime(now + 999, now)).toBe("刚刚"); // 未来钳到 0
});
