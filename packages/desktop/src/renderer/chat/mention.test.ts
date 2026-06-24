import { describe, expect, test } from "bun:test";
import { detectMention, filterMentionSkills } from "./mention";

describe("detectMention", () => {
  test("returns null with no @", () => {
    expect(detectMention("hello world", 11)).toBeNull();
  });

  test("triggers on @ at start of input", () => {
    expect(detectMention("@", 1)).toEqual({ start: 0, query: "" });
  });

  test("triggers on @ after whitespace and captures the query", () => {
    expect(detectMention("see @sk", 7)).toEqual({ start: 4, query: "sk" });
  });

  test("ignores @ inside an email address", () => {
    expect(detectMention("foo@bar.com", 11)).toBeNull();
  });

  test("closes when whitespace appears after @", () => {
    expect(detectMention("@sk ", 4)).toBeNull();
  });

  test("query is only the slice up to caret, not past it", () => {
    // caret sits between 'a' and 'b'
    expect(detectMention("@ab", 2)).toEqual({ start: 0, query: "a" });
  });

  test("handles @ surrounded by line break before it", () => {
    expect(detectMention("first\n@x", 8)).toEqual({ start: 6, query: "x" });
  });

  test("respects 80-char lookback cap", () => {
    const longTail = "x".repeat(85);
    expect(detectMention(`@${longTail}`, 1 + longTail.length)).toBeNull();
  });
});

describe("filterMentionSkills", () => {
  test("matches skill name but not description/comment text", () => {
    const skills = [
      {
        name: "browser",
        description: "contains only the comment-only word",
        source: "user" as const,
        filePath: "/skills/browser/SKILL.md",
      },
      {
        name: "comment-helper",
        description: "plain helper",
        source: "user" as const,
        filePath: "/skills/comment-helper/SKILL.md",
      },
    ];

    expect(filterMentionSkills(skills, "browser").map((s) => s.name)).toEqual(["browser"]);
    expect(filterMentionSkills(skills, "comment-only").map((s) => s.name)).toEqual([]);
    expect(filterMentionSkills(skills, "comment-helper").map((s) => s.name)).toEqual([
      "comment-helper",
    ]);
  });
});
