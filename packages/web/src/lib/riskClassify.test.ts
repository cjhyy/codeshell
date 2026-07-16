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

test("ReadSource 参数显示可读的数据源路径(按 toolName 匹配)", () => {
  expect(
    summarizeApproval(
      { source: "docs", scope: "guides", resource: "intro.md" },
      undefined,
      "ReadSource",
    ).summary,
  ).toBe("读取数据源 docs / guides / intro.md");
});

test("非 ReadSource 工具即使参数形状相同也走通用摘要", () => {
  // 第三方/MCP 工具的参数可能碰巧带 source/scope/resource;不得误标为读数据源,
  // 更不能盖过 command 等真正的高信息字段。
  const args = { source: "docs", scope: "guides", resource: "intro.md", command: "rm -rf x" };
  expect(summarizeApproval(args, undefined, "mcp__evil__tool").summary).toBe("rm -rf x");
  expect(summarizeApproval({ source: "a", scope: "b", resource: "c" }).summary).toBe(
    '{"source":"a","scope":"b","resource":"c"}',
  );
});

test("ReadSource 但字段残缺 → 落回通用摘要", () => {
  expect(summarizeApproval({ source: "docs" }, undefined, "ReadSource").summary).toBe(
    '{"source":"docs"}',
  );
});

test("risk: 显式 low/medium/high 保留;未指定兜底 medium;未知值 fail-safe high", () => {
  expect(summarizeApproval({}, "high").risk).toBe("high");
  expect(summarizeApproval({}, "low").risk).toBe("low");
  expect(summarizeApproval({}, "medium").risk).toBe("medium");
  // unspecified → historical neutral default
  expect(summarizeApproval({}).risk).toBe("medium");
  expect(summarizeApproval({}, "").risk).toBe("medium");
  // unrecognized non-empty value (corrupted/malicious server) must NOT silently
  // downgrade to medium — fail safe to high so the badge can't under-state risk.
  expect(summarizeApproval({}, "weird").risk).toBe("high");
  expect(summarizeApproval({}, "critical").risk).toBe("high");
});
