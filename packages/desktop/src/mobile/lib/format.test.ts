import { test, expect } from "bun:test";
import { basename, relativeTime } from "./format";

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
