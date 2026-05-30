import { describe, test, expect } from "bun:test";
import { parseRedirectTarget } from "./redirect-target.js";

// Regression: /> \s*(\S+)\s*$/ matched the first non-whitespace run after '>',
// so `cmd > "my file.txt"` extracted `"my` (review-2026-05-30). Handle quoted
// paths.

describe("parseRedirectTarget", () => {
  test("unquoted path", () => {
    expect(parseRedirectTarget("echo hi > out.txt")).toBe("out.txt");
  });

  test("append redirect", () => {
    expect(parseRedirectTarget("echo hi >> log.txt")).toBe("log.txt");
  });

  test("double-quoted path with spaces", () => {
    expect(parseRedirectTarget('echo hi > "my file.txt"')).toBe("my file.txt");
  });

  test("single-quoted path with spaces", () => {
    expect(parseRedirectTarget("echo hi > 'a b.txt'")).toBe("a b.txt");
  });

  test("no redirect → undefined", () => {
    expect(parseRedirectTarget("echo hi")).toBeUndefined();
  });
});
