import { test, expect } from "bun:test";
import { summarizeApproval } from "./riskClassify";

test("按优先级从 args 提摘要", () => {
  expect(summarizeApproval({ command: "rm -rf x" }).summary).toBe("rm -rf x");
  expect(summarizeApproval({ file_path: "/a/b" }).summary).toBe("/a/b");
  expect(summarizeApproval({ url: "http://x" }).summary).toBe("http://x");
  // command 优先于 path
  expect(summarizeApproval({ path: "/p", command: "ls" }).summary).toBe("ls");
});

test("空字符串跳过,落到下一个键", () => {
  expect(summarizeApproval({ command: "", file_path: "/a" }).summary).toBe("/a");
});

test("无已知字段 → JSON 兜底", () => {
  expect(summarizeApproval({ weird: 1 }).summary).toBe('{"weird":1}');
  expect(summarizeApproval(undefined).summary).toBe("{}");
});

test("risk 兜底 medium,显式 low/high 保留", () => {
  expect(summarizeApproval({}, "high").risk).toBe("high");
  expect(summarizeApproval({}, "low").risk).toBe("low");
  expect(summarizeApproval({}).risk).toBe("medium");
  expect(summarizeApproval({}, "weird").risk).toBe("medium");
});
