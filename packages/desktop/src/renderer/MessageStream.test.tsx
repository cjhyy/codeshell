import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MessageStream } from "./MessageStream";
import type { Message } from "./types";

describe("MessageStream — empty streaming assistant guard", () => {
  test("hides assistant with empty text while streaming", () => {
    const messages: Message[] = [
      { kind: "user", id: "u1", text: "hi" },
      { kind: "assistant", id: "a1", text: "", done: false },
    ];
    const html = renderToStaticMarkup(<MessageStream messages={messages} />);
    expect(html).not.toContain("…");
    expect(html).toContain("hi");
  });

  test("renders assistant with non-empty streaming text", () => {
    const messages: Message[] = [{ kind: "assistant", id: "a1", text: "Hel", done: false }];
    const html = renderToStaticMarkup(<MessageStream messages={messages} />);
    expect(html).toContain("Hel");
  });

  test("renders done assistant with empty text (defensive)", () => {
    const messages: Message[] = [{ kind: "assistant", id: "a1", text: "", done: true }];
    const html = renderToStaticMarkup(<MessageStream messages={messages} />);
    expect(html).not.toContain("…");
  });
});

describe("MessageStream — empty marker suppression (no blank blocks)", () => {
  // The replay path can synthesize these with empty content; each must
  // render nothing rather than a padded blank block.
  test("hides a system message with empty text", () => {
    const messages: Message[] = [
      { kind: "user", id: "u1", text: "hi" },
      { kind: "system", id: "s1", text: "" },
    ];
    const html = renderToStaticMarkup(<MessageStream messages={messages} />);
    // No empty centered marker div beyond the user bubble.
    expect(html).not.toContain("text-center");
  });

  test("hides a thinking message with empty text", () => {
    const messages: Message[] = [
      { kind: "user", id: "u1", text: "hi" },
      { kind: "thinking", id: "t1", text: "", done: true },
    ];
    const html = renderToStaticMarkup(<MessageStream messages={messages} />);
    expect(html).not.toContain("cs-thinking");
  });

  test("still renders a thinking message that has text", () => {
    const messages: Message[] = [{ kind: "thinking", id: "t1", text: "pondering", done: true }];
    const html = renderToStaticMarkup(<MessageStream messages={messages} />);
    expect(html).toContain("思考过程");
    expect(html).toContain('type="button"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain("aria-controls=");
    expect(html).not.toContain("pondering");
    const runningHtml = renderToStaticMarkup(
      <MessageStream messages={[{ ...messages[0], done: false } as Message]} />,
    );
    expect(runningHtml).toContain("正在思考");
  });
});

describe("MessageStream — injected system reminders", () => {
  test("renders a system reminder as folded task information, not a user bubble", () => {
    const messages: Message[] = [
      {
        kind: "user",
        id: "reminder",
        text: "<system-reminder>background task finished</system-reminder>",
        injected: true,
      },
    ];

    const html = renderToStaticMarkup(<MessageStream messages={messages} />);
    expect(html).toContain("系统任务信息");
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain("background task finished");
    expect(html).not.toContain("&lt;system-reminder&gt;");
  });
});

describe("MessageStream — goal extension actions", () => {
  function approachingGoal(nearest: "turns" | "stopBlocks", withTool = true): Message[] {
    return [
      {
        kind: "user",
        id: "goal-user",
        text: "继续检查项目",
        isGoal: true,
        turnTiming: { startedAt: 1, completed: false },
      },
      ...(withTool
        ? ([
            {
              kind: "tool",
              id: "goal-tool",
              toolName: "Read",
              args: "{}",
              result: "done",
              status: "succeeded",
              startedAt: 2,
              endedAt: 3,
            },
          ] satisfies Message[])
        : []),
      {
        kind: "goal_progress",
        id: "goal-limit",
        status: "approaching_limit",
        nearest,
        round: 4,
        turnsRemaining: 2,
        stopBlocksRemaining: 1,
      },
      { kind: "assistant", id: "goal-stream", text: "继续检查中", done: false },
    ];
  }

  for (const [nearest, label] of [
    ["turns", "再续 50 轮"],
    ["stopBlocks", "再续 15 次"],
  ] as const) {
    test(`live tool group retains the ${nearest} extension action`, () => {
      const html = renderToStaticMarkup(
        <MessageStream
          messages={approachingGoal(nearest)}
          liveTurnActive
          onExtendGoal={() => {}}
        />,
      );
      expect(html).toContain('aria-expanded="true"');
      expect(html).toContain(`${label}</button>`);
    });
  }

  test("callback-free grouped views retain progress without offering an action", () => {
    const html = renderToStaticMarkup(
      <MessageStream messages={approachingGoal("turns")} liveTurnActive />,
    );
    expect(html).toContain("目标接近轮次上限");
    expect(html).not.toContain("再续 50 轮");
  });

  test("a flat goal marker retains its existing extension action", () => {
    const html = renderToStaticMarkup(
      <MessageStream
        messages={approachingGoal("turns", false)}
        liveTurnActive
        onExtendGoal={() => {}}
      />,
    );
    expect(html).toContain("再续 50 轮</button>");
  });
});

describe("MessageStream — restored user attachments", () => {
  const shot = {
    kind: "image" as const,
    path: ".code-shell/attachments/s/modern-shot.png",
    absPath: "/repo/.code-shell/attachments/s/modern-shot.png",
    sessionId: "s",
    mime: "image/png",
    originalName: "modern-shot.png",
    size: 68,
  };

  test("a local session restored from the journal shows its attachment summary", () => {
    const messages: Message[] = [
      { kind: "user", id: "u1", text: "what is in this screenshot?", attachments: [shot] },
    ];
    const html = renderToStaticMarkup(<MessageStream messages={messages} />);
    expect(html).toContain("what is in this screenshot?");
    expect(html).toContain("modern-shot.png");
  });

  test("an image-only restored message still renders a user bubble", () => {
    const messages: Message[] = [{ kind: "user", id: "u1", text: "", attachments: [shot] }];
    const html = renderToStaticMarkup(<MessageStream messages={messages} />);
    expect(html).toContain("modern-shot.png");
  });
});
