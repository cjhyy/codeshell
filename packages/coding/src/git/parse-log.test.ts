import { describe, test, expect } from "bun:test";
import { GIT_LOG_FIELD_SEPARATOR, parseGitLog } from "./parse-log.js";

// Regression: getGitLog destructured the split fields without validating the
// shape; a line missing separators yielded undefined fields and risked
// undefined property access (review-2026-05-30). parseGitLog tolerates
// malformed lines.

describe("coding parseGitLog", () => {
  test("parses well-formed GIT_LOG_FORMAT lines", () => {
    const raw = ["abcdef1234", "fix things", "Alice", "2026-05-30 10:00:00 +0000"].join(
      GIT_LOG_FIELD_SEPARATOR,
    );
    expect(parseGitLog(raw)).toEqual([
      {
        hash: "abcdef12",
        message: "fix things",
        author: "Alice",
        date: "2026-05-30 10:00:00 +0000",
      },
    ]);
  });

  test("skips empty/whitespace lines", () => {
    expect(parseGitLog("")).toEqual([]);
    expect(parseGitLog("\n  \n")).toEqual([]);
  });

  test("does not throw on a malformed line with no separators", () => {
    expect(() => parseGitLog("garbage-no-pipes")).not.toThrow();
    const out = parseGitLog("garbage-no-pipes");
    expect(out[0]?.hash).toBe("garbage-");
    expect(out[0]?.message).toBe(""); // missing fields default to empty string
  });
});
