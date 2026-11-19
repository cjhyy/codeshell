import { describe, expect, test } from "bun:test";
import { goalQuestionsText, parseGoalQuestions } from "./goal-questions";

describe("wait_for_user questions", () => {
  test("absent questions stay a plain-text wait", () => {
    expect(parseGoalQuestions(undefined)).toEqual({});
  });

  test("valid questions are trimmed, given ids and keep option descriptions", () => {
    const { questions, error } = parseGoalQuestions([
      {
        header: " 部署 ",
        question: " 怎么部署？ ",
        options: [{ label: "执行机（推荐）", description: "我写清单" }, { label: "不部署" }],
      },
    ]);
    expect(error).toBeUndefined();
    expect(questions).toEqual([
      {
        id: "q1",
        header: "部署",
        question: "怎么部署？",
        options: [{ label: "执行机（推荐）", description: "我写清单" }, { label: "不部署" }],
      },
    ]);
    expect(goalQuestionsText(questions!)).toBe("部署: 怎么部署？ [执行机（推荐） / 不部署]");
  });

  test("malformed questions are rejected with a reason the model can act on", () => {
    const one = (q: Record<string, unknown>) => parseGoalQuestions([q]).error;
    expect(parseGoalQuestions([]).error).toContain("1 to 3");
    expect(parseGoalQuestions([1, 2, 3, 4]).error).toContain("1 to 3");
    expect(one({ question: "选？", options: [{ label: "A" }] })).toContain("2 to 4");
    expect(one({ question: "选？", options: [{ label: "A" }, { label: "A" }] })).toContain(
      "distinct",
    );
    expect(one({ question: "x".repeat(301), options: [{ label: "A" }, { label: "B" }] })).toContain(
      "background in your reply",
    );
    expect(
      parseGoalQuestions([
        { id: "a", question: "一？", options: [{ label: "A" }, { label: "B" }] },
        { id: "a", question: "二？", options: [{ label: "A" }, { label: "B" }] },
      ]).error,
    ).toContain("repeated");
  });
});
