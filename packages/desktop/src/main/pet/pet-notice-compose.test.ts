import { describe, expect, test } from "bun:test";
import { composeDigestBody, composeNoticeBody, noticeLine } from "./pet-notice-compose";

describe("composeNoticeBody", () => {
  test("templates each kind as plain text and prefers a pre-written body", () => {
    expect(composeNoticeBody("session.failed", { title: "Build", error: "tsc\nexit 2" })).toBe(
      "「Build」没做完：tsc exit 2",
    );
    expect(composeNoticeBody("session.done", { title: "Build" })).toBe("「Build」做完了");
    expect(composeNoticeBody("session.done", { title: "Build" }, "  Mimi says hi ")).toBe(
      "Mimi says hi",
    );
    expect(composeNoticeBody("session.done", {})).toBe("「一个会话」做完了");
  });

  test("blocked lists options and adds the reply hint only with a code", () => {
    const facts = {
      title: "Deploy",
      question: "Region?",
      options: [{ label: "us", recommended: true }, { label: "eu" }],
    };
    expect(composeNoticeBody("session.blocked", facts)).toBe(
      "「Deploy」需要你决定：Region?\n1. us（推荐）\n2. eu",
    );
    expect(composeNoticeBody("session.blocked", { ...facts, code: "Q3" })).toContain(
      "回复：回答 Q3 序号 / 跳过 Q3 / 等待 Q3",
    );
  });

  test("strips control, bidi and zero-width characters", () => {
    expect(composeNoticeBody("session.done", {}, "\u202eabc\u0007\u200b\r\nnext\tline\u2066")).toBe(
      "abc\nnext line",
    );
    expect(
      composeNoticeBody("session.failed", { title: "Bu\u200bild\u202e", error: "a\u2028b" }),
    ).toBe("「Build」没做完：ab");
    expect(noticeLine("\u200b\u200f")).toBeUndefined();
  });

  test("caps session-provided text", () => {
    const body = composeNoticeBody("session.done", { title: "x".repeat(500), summary: "y" });
    expect(body.length).toBeLessThan(120);
    expect(body).toContain("…");
  });
});

describe("composeDigestBody", () => {
  test("lists at most ten notices and counts the rest", () => {
    const members = Array.from({ length: 12 }, (_, index) => ({
      kind: "session.done",
      facts: { title: `T${index}` },
    }));
    const lines = composeDigestBody(members).split("\n");
    expect(lines[0]).toBe("你不在时：");
    expect(lines).toHaveLength(12);
    expect(lines[10]).toBe("- 「T9」做完了");
    expect(lines[11]).toBe("…还有 2 条");
  });
});
