import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { formatGoalElapsed, GoalBar } from "./GoalBar";
import { goalChoicesAnswer, goalChoicesComplete } from "./GoalReplyChoices";
import type { ActiveGoal, GoalUserQuestion } from "../types";
import { goalQuestionsText } from "../../shared/goal-questions";

const goal: ActiveGoal = {
  objective: "帮我看看设计工作台怎么优化能够对标 figma",
  goalId: "g1",
  revision: 2,
  round: 3,
  paused: false,
  setAtMs: 1_000_000,
};
const at = (ms: number) => () => ms;

describe("formatGoalElapsed", () => {
  test("shows the largest unit with zero-padded tails", () => {
    expect(formatGoalElapsed(45_000)).toBe("45s");
    expect(formatGoalElapsed(3 * 60_000 + 5_000)).toBe("3m 05s");
    expect(formatGoalElapsed((12 * 3600 + 57 * 60 + 34) * 1000)).toBe("12h 57m 34s");
    expect(formatGoalElapsed(-5)).toBe("0s");
  });
});

describe("GoalBar", () => {
  test("a driving Goal shows its target icon, objective and active time", () => {
    const html = renderToStaticMarkup(
      <GoalBar
        goal={{ ...goal, activeMs: 0, clockSinceMs: 1_000_000 }}
        busy
        now={at(1_000_000 + 65_000)}
        onPausedChange={() => {}}
      />,
    );
    expect(html).toContain('data-goal-state="running"');
    expect(html).toContain("lucide-target");
    expect(html).toContain(goal.objective);
    expect(html).toContain("1m 05s");
    expect(html).toContain("lucide-pause");
  });

  test("a paused Goal swaps to the pause badge and offers Resume", () => {
    const html = renderToStaticMarkup(
      <GoalBar
        goal={{ ...goal, paused: true }}
        busy={false}
        now={at(1_000_000)}
        onPausedChange={() => {}}
      />,
    );
    expect(html).toContain('data-goal-state="paused"');
    expect(html).toContain("lucide-circle-pause");
    expect(html).not.toContain("lucide-target");
    expect(html).toContain("lucide-play");
  });

  test("a limit pause says so and that a message resumes it", () => {
    const html = renderToStaticMarkup(
      <GoalBar
        goal={{ ...goal, paused: true, pauseReason: "time_budget" }}
        busy={false}
        now={at(1_000_000)}
        onPausedChange={() => {}}
      />,
    );
    expect(html).toContain('data-goal-state="paused"');
    expect(html).toContain("目标已停下（设定的预算用完）");
    expect(html).toContain("发一条消息或点击恢复");
    expect(html).toContain('data-goal-pause="time_budget"');
  });

  test("a Goal stopped for lack of progress is shown as blocked, not as the user's pause", () => {
    const html = renderToStaticMarkup(
      <GoalBar
        goal={{ ...goal, paused: true, pauseReason: "no_progress" }}
        busy={false}
        now={at(1_000_000)}
        onPausedChange={() => {}}
      />,
    );
    expect(html).toContain('data-goal-pause="no_progress"');
    expect(html).toContain("目标卡住了（连续几轮没有进展）");
    expect(html).not.toContain("已暂停的目标");
  });

  test("a turn running beside a Goal the user paused is not shown as the Goal's", () => {
    const html = renderToStaticMarkup(
      <GoalBar
        goal={{ ...goal, paused: true, pauseReason: "user_stop" }}
        busy
        now={at(1_000_000)}
        onPausedChange={() => {}}
      />,
    );
    expect(html).toContain('data-goal-state="paused"');
    expect(html).toContain("已暂停的目标 · 当前这轮不属于它");
    expect(html).not.toContain("预算用完");
  });

  test("controls are disabled while a Goal control is in flight", () => {
    const html = renderToStaticMarkup(
      <GoalBar
        goal={goal}
        busy={false}
        pending
        now={at(0)}
        onPausedChange={() => {}}
        onDelete={() => {}}
      />,
    );
    expect(html.match(/disabled=""/g)?.length).toBe(2);
  });

  test("unknown accounting hides wall-clock age, including legacy waiting goals", () => {
    const html = renderToStaticMarkup(
      <GoalBar
        goal={{ ...goal, waitingForUser: "这处效果是否可接受？" }}
        busy={false}
        now={at(250_000_000)}
      />,
    );
    expect(html).not.toMatch(/\d+s</);
  });

  test("goal time replaces the age once accounting is known, and a stopped clock does not run", () => {
    const running = renderToStaticMarkup(
      <GoalBar
        goal={{ ...goal, activeMs: 2 * 3600_000, clockSinceMs: 5_000_000 }}
        busy={false}
        now={at(5_000_000 + 125_000)}
      />,
    );
    // 2h of settled goal time plus the open 2m 05s segment, not the time since setAtMs.
    expect(running).toContain("第 3 轮 · 2h 02m 05s");
    expect(running).toContain("暂停、等你回复时不计");
    const stopped = renderToStaticMarkup(
      <GoalBar goal={{ ...goal, activeMs: 90_000 }} busy={false} now={at(99_000_000)} />,
    );
    expect(stopped).toContain("第 3 轮 · 1m 30s");
  });

  test("a Goal waiting on the user shows the question state, unless it is paused", () => {
    const waiting = renderToStaticMarkup(
      <GoalBar goal={{ ...goal, waitingForUser: "允许新增权限吗？" }} busy={false} now={at(0)} />,
    );
    expect(waiting).toContain('data-goal-state="waiting"');
    expect(waiting).toContain("lucide-message-circle-question");
    expect(waiting).toContain("等待你的回复");
    expect(waiting).toContain("允许新增权限吗？</p>");
    const paused = renderToStaticMarkup(
      <GoalBar
        goal={{ ...goal, paused: true, waitingForUser: "允许新增权限吗？" }}
        busy={false}
        now={at(0)}
      />,
    );
    expect(paused).toContain('data-goal-state="paused"');
    expect(paused).not.toContain("data-goal-reply");
  });

  test("a waiting question is shown without its own input: the main composer answers it", () => {
    const html = renderToStaticMarkup(
      <GoalBar
        goal={{ ...goal, activeMs: 65_000, waitingForUser: "这处效果是否可接受？" }}
        busy={false}
        now={at(250_000_000)}
        onReply={() => {}}
      />,
    );
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain("data-goal-reply");
    expect(html).toContain("这处效果是否可接受？");
    // One input box on screen: the banner carries no textarea or send button.
    expect(html).not.toContain("<textarea");
    expect(html).not.toContain("data-goal-reply-choice");
    expect(html).toContain("1m 05s");
    expect(html).toContain("在下方输入框回答");
  });

  test("a preference question offers its options and marks the stated default as recommended", () => {
    const html = renderToStaticMarkup(
      <GoalBar
        goal={{
          ...goal,
          waitingForUser: "发 rc 还是正式版？",
          waitingDetail: {
            level: "preference",
            questions: [
              {
                id: "q1",
                question: "发 rc 还是正式版？",
                options: [{ label: "rc" }, { label: "正式版" }],
                default: "正式版",
              },
            ],
          },
        }}
        busy={false}
        now={at(0)}
        onReply={() => {}}
      />,
    );
    expect(html).toContain('data-goal-reply-level="preference"');
    expect(html.match(/data-goal-reply-choice=/g)).toHaveLength(2);
    expect(html.match(/data-goal-reply-choice="default"/g)).toHaveLength(1);
    expect(html).toContain("正式版");
    expect(html).toMatch(/data-goal-reply-choice="default"[^>]*>.*?正式版.*?>推荐</);
    // The lone question is the banner's text, shown once.
    const banner = html.slice(html.indexOf("data-goal-reply="));
    expect(banner.match(/发 rc 还是正式版？/g)).toHaveLength(2); // text + radiogroup label
    expect(html).not.toContain("<legend");
    expect(html).not.toContain("data-goal-reply-submit");
    expect(html).not.toContain("<textarea");
  });

  test("a consent question renders explicit 同意 / 不同意 instead of model options", () => {
    const html = renderToStaticMarkup(
      <GoalBar
        goal={{
          ...goal,
          waitingForUser: "要把新密钥写入生产服务器吗？",
          waitingDetail: {
            level: "consent",
            questions: [
              { id: "q1", question: "选？", options: [{ label: "随便" }, { label: "都行" }] },
            ],
          },
        }}
        busy={false}
        now={at(0)}
        onReply={() => {}}
      />,
    );
    expect(html).toContain('data-goal-reply-level="consent"');
    expect(html.match(/data-goal-reply-choice=/g)).toHaveLength(2);
    expect(html).toContain(">同意<");
    expect(html).toContain(">不同意<");
    expect(html).not.toContain("随便");
    expect(html).toContain("需要你明确同意才会执行");
  });

  test("a queued question is not rendered beside another pending item", () => {
    const html = renderToStaticMarkup(
      <GoalBar
        goal={{
          ...goal,
          waitingForUser: "发 rc 还是正式版？",
          waitingDetail: {
            level: "preference",
            questions: [
              {
                id: "q1",
                question: "发 rc 还是正式版？",
                options: [{ label: "rc" }, { label: "正式版" }],
              },
            ],
          },
        }}
        busy={false}
        now={at(0)}
        onReply={() => {}}
        replyQueued
      />,
    );
    expect(html).toContain('data-goal-state="waiting"');
    expect(html).toContain("data-goal-reply-queued");
    expect(html).not.toContain("data-goal-reply-choice");
    expect(html).not.toContain("发 rc 还是正式版？</p>");
  });

  test("a failed answer is reported on the question, and chips lock while a turn runs", () => {
    const html = renderToStaticMarkup(
      <GoalBar
        goal={{
          ...goal,
          waitingForUser: "发 rc 还是正式版？",
          waitingDetail: {
            level: "preference",
            questions: [
              {
                id: "q1",
                question: "发 rc 还是正式版？",
                options: [{ label: "rc" }, { label: "正式版" }],
              },
            ],
          },
        }}
        busy
        now={at(0)}
        onReply={() => {}}
        replyFailed
      />,
    );
    expect(html).toContain('role="alert"');
    expect(html).toContain("回复未发送，请重试。");
    expect(html).toMatch(/disabled=""[^>]*data-goal-reply-choice/);
  });

  const deploy = {
    id: "deploy",
    header: "部署方式",
    question: "服务端怎么部署？",
    options: [
      { label: "你在执行机上部署", description: "我写部署计划和验收清单" },
      { label: "给我服务器访问方式" },
    ],
  };
  const release: GoalUserQuestion = {
    id: "release",
    header: "发版",
    question: "发哪个版本？",
    options: [{ label: "rc.3" }, { label: "合并后发 0.11.0" }],
    default: "合并后发 0.11.0",
  };

  test("structured choices render as option cards in the banner; long context starts collapsed", () => {
    const context =
      "生产服务器部署我这台机器连不上：SSH 都被拒，也没有 tccli，Link 里也没有腾讯云连接。上次是在执行机上部署的，所以这次需要你决定部署方式，以及发版指的是哪一个版本。v0.11.0-rc.3 的发布流水线已经在跑，网页优化 PR 合并后也可以再发正式版。";
    const html = renderToStaticMarkup(
      <GoalBar
        goal={{
          ...goal,
          waitingForUser: context,
          waitingDetail: { level: "preference", questions: [deploy, release] },
        }}
        busy={false}
        now={at(0)}
        onReply={() => {}}
      />,
    );
    // One banner, no input of its own: free-form answers use the main composer.
    expect(html.match(/data-goal-reply=/g)).toHaveLength(1);
    expect(html).not.toContain("<textarea");
    expect(html).not.toContain("<input");
    expect(html.match(/role="radiogroup"/g)).toHaveLength(2);
    expect(html).toContain("部署方式");
    expect(html).toContain("我写部署计划和验收清单");
    // Recommended: the first option, or the stated default.
    expect(html.match(/>推荐</g)).toHaveLength(2);
    expect(html).toMatch(/data-goal-reply-choice="default"[^>]*>.*?你在执行机上部署/);
    expect(html).toMatch(/data-goal-reply-choice="option"[^>]*>.*?rc\.3/);
    expect(html).toContain("line-clamp-2");
    expect(html).toContain("展开说明");
    // Several questions are sent together, and only once each has a pick.
    expect(html).toMatch(
      /<button[^>]*disabled=""[^>]*data-goal-reply-submit|data-goal-reply-submit[^>]*disabled=""/,
    );
  });

  test("a lone question with a header keeps its header and is not repeated as context", () => {
    const html = renderToStaticMarkup(
      <GoalBar
        goal={{
          ...goal,
          waitingForUser: goalQuestionsText([deploy]),
          waitingDetail: { level: "preference", questions: [deploy] },
        }}
        busy={false}
        now={at(0)}
        onReply={() => {}}
      />,
    );
    expect(html).toContain("<legend");
    expect(html.slice(html.indexOf("data-goal-reply="))).not.toContain(goalQuestionsText([deploy]));
    expect(html).not.toContain("data-goal-reply-submit");
  });

  test("the combined answer lists one line per question under its header", () => {
    expect(goalChoicesComplete([deploy, release], { deploy: "给我服务器访问方式" })).toBe(false);
    const choices = { deploy: "你在执行机上部署", release: "rc.3" };
    expect(goalChoicesComplete([deploy, release], choices)).toBe(true);
    expect(goalChoicesAnswer([deploy, release], choices)).toBe(
      "部署方式：你在执行机上部署\n发版：rc.3",
    );
    expect(goalChoicesAnswer([deploy], choices)).toBe("部署方式：你在执行机上部署");
    // A lone question without a header is answered with the bare label.
    expect(goalChoicesAnswer([{ ...release, header: undefined }], choices)).toBe("rc.3");
  });
});
