import { describe, expect, test } from "bun:test";
import { EXTERNAL_GOAL_TOOL_CATALOG } from "./external-runtime-goal-tools.js";
import { EXTERNAL_GOAL_TOOLS, isExternalGoalToolName } from "./external-runtime-goals.js";
import {
  goalQuestionContext,
  goalQuestionFullText,
  goalQuestionRecommended,
  goalQuestionsText,
  normalizeGoalQuestion,
  replayedGoalQuestionDetail,
} from "../shared/goal-questions.js";

const definition = (name: string) =>
  EXTERNAL_GOAL_TOOL_CATALOG.find((tool) => tool.definition.name === name)!.definition;

describe("external Goal tool contracts", () => {
  test("every Goal controller tool is declared once", () => {
    expect(EXTERNAL_GOAL_TOOL_CATALOG.map((tool) => tool.definition.name)).toEqual([
      ...EXTERNAL_GOAL_TOOLS,
    ]);
    expect(EXTERNAL_GOAL_TOOLS).toContain("wait_for_background");
  });

  test("wait_for_user is structured and tells the model not to repeat the question", () => {
    const tool = definition("wait_for_user");
    expect(tool.description).not.toContain("Ask the same question in your reply");
    expect(tool.description).toContain("do not repeat it in your reply text");
    expect(tool.description).toContain("At most one call per turn");
    expect(tool.description).toContain("never write a multiple-choice question as text");
    const schema = tool.inputSchema as {
      properties: Record<
        string,
        { enum?: string[]; maxLength?: number; maxItems?: number; minItems?: number }
      >;
      required: string[];
    };
    // `question` is optional once `questions` carries the asking; a bare one stays valid.
    expect(schema.required).toEqual(["goalId", "revision"]);
    expect(schema.properties.question!.maxLength).toBe(600);
    expect(schema.properties.questions).toMatchObject({ minItems: 1, maxItems: 3 });
    expect(schema.properties.options).toMatchObject({ minItems: 2, maxItems: 4 });
    expect(schema.properties.level!.enum).toEqual(["preference", "consent"]);
    expect(schema.properties.default).toBeDefined();
  });

  test("wait_for_background needs only the goal identity", () => {
    const tool = definition("wait_for_background");
    expect(tool.description).toContain("never poll");
    expect((tool.inputSchema as { required: string[] }).required).toEqual(["goalId", "revision"]);
    expect(tool.isReadOnly).toBe(false);
  });

  test("provider-prefixed names are recognized as Goal controls", () => {
    expect(isExternalGoalToolName("wait_for_background")).toBe(true);
    expect(isExternalGoalToolName("mcp__codeshell_tools__wait_for_user")).toBe(true);
    expect(isExternalGoalToolName("mcp__codeshell_tools__Bash")).toBe(false);
    expect(isExternalGoalToolName("Bash")).toBe(false);
  });
});

describe("wait_for_user question normalization", () => {
  const AB = [{ label: "A" }, { label: "B" }];
  const ok = (args: Record<string, unknown>) => {
    const parsed = normalizeGoalQuestion(args);
    if ("error" in parsed) throw new Error(parsed.error);
    return parsed.question;
  };
  const error = (args: Record<string, unknown>) => {
    const parsed = normalizeGoalQuestion(args);
    return "error" in parsed ? parsed.error : "";
  };

  test("a bare question stays a plain-text preference", () => {
    expect(ok({ question: " 继续吗？ " })).toEqual({ text: "继续吗？", level: "preference" });
    expect(error({})).toContain("needs the question");
    expect(error({ question: "x".repeat(601) })).toContain("at most 600");
    expect(error({ question: "继续吗？", level: "urgent" })).toContain("level must be");
  });

  test("valid questions are trimmed, given ids and keep descriptions and defaults", () => {
    const question = ok({
      questions: [
        {
          header: " 部署 ",
          question: " 怎么部署？ ",
          options: [{ label: "执行机", description: "我写清单" }, { label: "不部署" }],
          default: " 不部署 ",
        },
      ],
    });
    expect(question).toEqual({
      text: "部署: 怎么部署？ [执行机 / 不部署]",
      level: "preference",
      questions: [
        {
          id: "q1",
          header: "部署",
          question: "怎么部署？",
          options: [{ label: "执行机", description: "我写清单" }, { label: "不部署" }],
          default: "不部署",
        },
      ],
    });
    expect(goalQuestionsText(question.questions!)).toBe(question.text);
    // The text only restates the choices, so there is no separate context to show.
    expect(goalQuestionContext(question.text, question.questions)).toBe("");
    expect(goalQuestionFullText(question.text, question.questions)).toBe(question.text);
    expect(goalQuestionRecommended(question.questions![0]!)).toBe("不部署");
  });

  test("`question` beside `questions` is their context; recommended defaults to the first option", () => {
    const question = ok({
      question: "连不上生产服务器。",
      questions: [{ id: "deploy", question: "怎么部署？", options: AB }],
    });
    expect(question.text).toBe("连不上生产服务器。");
    expect(goalQuestionContext(question.text, question.questions)).toBe("连不上生产服务器。");
    expect(goalQuestionFullText(question.text, question.questions)).toBe(
      "连不上生产服务器。 怎么部署？ [A / B]",
    );
    expect(goalQuestionRecommended(question.questions![0]!)).toBe("A");
  });

  test("flat options and default normalize into a single-entry questions list", () => {
    const question = ok({ question: "发哪个？", options: ["rc", " 正式版 "], default: "正式版" });
    expect(question).toEqual({
      text: "发哪个？",
      level: "preference",
      questions: [
        {
          id: "q1",
          question: "发哪个？",
          options: [{ label: "rc" }, { label: "正式版" }],
          default: "正式版",
        },
      ],
    });
    expect(goalQuestionContext(question.text, question.questions)).toBe("");
    expect(error({ question: "发哪个？", options: ["rc"] })).toContain("2 to 4");
    expect(error({ question: "发哪个？", options: ["rc", 3] })).toContain("options[1]");
    expect(error({ question: "发哪个？", options: ["rc", "正式版"], default: "都行" })).toContain(
      "default must be one of the option labels",
    );
    expect(error({ options: ["rc", "正式版"] })).toContain("need the question");
    expect(
      error({
        question: "发哪个？",
        options: ["a", "b"],
        questions: [{ question: "?", options: AB }],
      }),
    ).toContain("not both");
  });

  test("a consent call is one question, answered agree / disagree by the host", () => {
    expect(ok({ question: "写入生产密钥吗？", level: "consent", options: ["写", "不写"] })).toEqual(
      { text: "写入生产密钥吗？", level: "consent" },
    );
    expect(
      ok({
        question: "新密钥已生成。",
        level: "consent",
        questions: [{ id: "write", question: "写入生产服务器吗？", options: AB, default: "A" }],
      }),
    ).toEqual({ text: "新密钥已生成。\n\n写入生产服务器吗？", level: "consent" });
    expect(
      error({
        level: "consent",
        questions: [
          { id: "a", question: "一？", options: AB },
          { id: "b", question: "二？", options: AB },
        ],
      }),
    ).toContain("single question");
  });

  test("malformed questions are rejected with a reason the model can act on", () => {
    const one = (q: Record<string, unknown>) => error({ questions: [q] });
    expect(error({ questions: [] })).toContain("1 to 3");
    expect(error({ questions: [1, 2, 3, 4] })).toContain("1 to 3");
    expect(one({ question: "选？", options: [{ label: "A" }] })).toContain("2 to 4");
    expect(one({ question: "选？", options: [{ label: "A" }, { label: "A" }] })).toContain(
      "distinct",
    );
    expect(one({ question: "x".repeat(301), options: AB })).toContain("background in your reply");
    expect(one({ question: "选？", options: AB, default: "C" })).toContain(
      "questions[0].default must be one of the option labels",
    );
    expect(
      error({
        questions: [
          { id: "a", question: "一？", options: AB },
          { id: "a", question: "二？", options: AB },
        ],
      }),
    ).toContain("repeated");
  });

  test("a replayed detail keeps what is well-formed, including the earlier flat form", () => {
    expect(replayedGoalQuestionDetail("继续吗？", undefined)).toBeUndefined();
    expect(replayedGoalQuestionDetail("继续吗？", { level: "nope" })).toEqual({
      level: "preference",
    });
    expect(
      replayedGoalQuestionDetail("发哪个？", { level: "preference", options: ["rc", "正式版"] }),
    ).toEqual({
      level: "preference",
      questions: [
        { id: "q1", question: "发哪个？", options: [{ label: "rc" }, { label: "正式版" }] },
      ],
    });
    expect(
      replayedGoalQuestionDetail("背景", {
        level: "preference",
        questions: [{ id: "x", question: "选？", options: AB }],
      }),
    ).toEqual({ level: "preference", questions: [{ id: "x", question: "选？", options: AB }] });
    // Malformed choices fall back to the plain question instead of dropping the wait.
    expect(
      replayedGoalQuestionDetail("选？", { level: "preference", questions: [{ options: 3 }] }),
    ).toEqual({ level: "preference" });
    expect(
      replayedGoalQuestionDetail("要发布吗？", {
        level: "consent",
        options: ["是", 3],
        default: 1,
      }),
    ).toEqual({ level: "consent" });
  });
});
