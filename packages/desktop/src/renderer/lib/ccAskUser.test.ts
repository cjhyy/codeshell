import { test, expect, describe } from "bun:test";
import { extractCcAskUser, buildCcAskUserAnswer } from "./ccAskUser";

describe("extractCcAskUser", () => {
  test("pulls option labels from the FIRST question (CC nested questions[] shape)", () => {
    const input = {
      questions: [
        {
          question: "用哪个方案?",
          header: "方案",
          options: [
            { label: "甲", description: "a" },
            { label: "乙", description: "b" },
          ],
          multiSelect: false,
        },
      ],
    };
    expect(extractCcAskUser(input)).toEqual({
      question: "用哪个方案?",
      options: ["甲", "乙"],
      multiSelect: false,
    });
  });

  test("multiSelect flag is carried through", () => {
    const input = {
      questions: [{ question: "选多个", options: [{ label: "A" }, { label: "B" }], multiSelect: true }],
    };
    expect(extractCcAskUser(input)?.multiSelect).toBe(true);
  });

  test("returns undefined for a non-AskUser input (no questions)", () => {
    expect(extractCcAskUser({ command: "ls" })).toBeUndefined();
    expect(extractCcAskUser(undefined)).toBeUndefined();
    expect(extractCcAskUser({ questions: [] })).toBeUndefined();
    expect(extractCcAskUser({ questions: [{ question: "q" }] })).toBeUndefined(); // no options
  });

  test("guards malformed options (drops non-string labels)", () => {
    const input = { questions: [{ question: "q", options: [{ label: "A" }, { foo: 1 }, { label: "B" }] }] };
    expect(extractCcAskUser(input)?.options).toEqual(["A", "B"]);
  });
});

describe("buildCcAskUserAnswer", () => {
  test("bakes a single answer into updatedInput.answers keyed by question text, questions passed through", () => {
    const input = {
      questions: [{ question: "用哪个方案?", options: [{ label: "甲" }, { label: "乙" }] }],
    };
    expect(buildCcAskUserAnswer(input, "甲")).toEqual({
      behavior: "allow",
      updatedInput: {
        questions: input.questions,
        answers: { "用哪个方案?": "甲" },
      },
    });
  });

  test("falls back to a synthetic key when the question text is missing", () => {
    const input = { questions: [{ options: [{ label: "甲" }] }] };
    const out = buildCcAskUserAnswer(input, "甲") as {
      updatedInput: { answers: Record<string, string> };
    };
    // Whatever the key, the chosen label is present as the answer.
    expect(Object.values(out.updatedInput.answers)).toEqual(["甲"]);
  });
});
