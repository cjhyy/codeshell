import { describe, expect, test } from "bun:test";
import { goalChoicesAnswer, goalChoicesComplete, splitRecommended } from "./GoalReplyChoices";
import type { GoalUserQuestion } from "../types";

const questions: GoalUserQuestion[] = [
  {
    id: "deploy",
    header: "部署方式",
    question: "服务端怎么部署？",
    options: [{ label: "你在执行机上部署（推荐）" }, { label: "这次先不部署" }],
  },
  {
    id: "release",
    header: "发版",
    question: "发哪个版本？",
    options: [{ label: "rc.3 (Recommended)" }, { label: "合并后发 0.11.0" }],
  },
];

describe("goal reply choices", () => {
  test("recommended markers are shown as a badge, not sent as part of the answer", () => {
    expect(splitRecommended("rc.3 (Recommended)")).toEqual({ text: "rc.3", recommended: true });
    expect(splitRecommended("你在执行机上部署（推荐）")).toEqual({
      text: "你在执行机上部署",
      recommended: true,
    });
    expect(splitRecommended("这次先不部署")).toEqual({ text: "这次先不部署", recommended: false });
  });

  test("every question needs a choice or a non-empty free-form answer", () => {
    expect(goalChoicesComplete(questions, { deploy: { label: "这次先不部署" } })).toBe(false);
    expect(
      goalChoicesComplete(questions, {
        deploy: { label: "这次先不部署" },
        release: { other: "  " },
      }),
    ).toBe(false);
    expect(
      goalChoicesComplete(questions, {
        deploy: { label: "这次先不部署" },
        release: { other: "等我确认" },
      }),
    ).toBe(true);
  });

  test("the reply lists one answer per question under its header", () => {
    expect(
      goalChoicesAnswer(questions, {
        deploy: { label: "你在执行机上部署（推荐）" },
        release: { other: "先发 rc.4" },
      }),
    ).toBe("部署方式：你在执行机上部署\n发版：先发 rc.4");
    expect(
      goalChoicesAnswer([{ ...questions[1]!, header: undefined }], {
        release: { label: "合并后发 0.11.0" },
      }),
    ).toBe("合并后发 0.11.0");
  });
});
