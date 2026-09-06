import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AskUserMessageView } from "./AskUserMessageView";
import type { AskUserMessage } from "../types";

function ask(over: Partial<AskUserMessage> = {}): AskUserMessage {
  return {
    kind: "ask_user",
    id: "q1",
    requestId: "r1",
    question: "工具想读取工作区外路径，是否允许？",
    header: "路径权限",
    multiSelect: false,
    options: [
      { label: "允许本次", description: "仅允许当前这一次" },
      { label: "拒绝", description: "阻止当前文件操作" },
    ],
    ...over,
  };
}

describe("AskUserMessageView optionsOnly", () => {
  test("normal multiple-choice shows the 其它… free-text escape hatch", () => {
    const html = renderToStaticMarkup(<AskUserMessageView message={ask()} onAnswer={() => {}} />);
    expect(html).toContain("其它…");
    expect(html).toContain("允许本次");
  });

  test("optionsOnly hides 其它… — a closed-set permission prompt cannot be free-typed", () => {
    const html = renderToStaticMarkup(
      <AskUserMessageView message={ask({ optionsOnly: true })} onAnswer={() => {}} />,
    );
    expect(html).not.toContain("其它…");
    expect(html).not.toContain("输入自定义回答");
    // The real options are still offered.
    expect(html).toContain("允许本次");
    expect(html).toContain("拒绝");
  });
});

describe("AskUserMessageView layout", () => {
  // The ask card sits in the same column as every other message view. Those
  // wrap in px-4 and size relatively; a fixed pixel width made this card both
  // narrower than the tool card above it and flush against the viewport edge.
  test("sizes with the message column instead of a fixed pixel width", () => {
    const html = renderToStaticMarkup(<AskUserMessageView message={ask()} onAnswer={() => {}} />);
    expect(html).not.toContain("max-w-[720px]");
    expect(html).toContain("px-4");
  });

  test("answered echo card matches the same column geometry", () => {
    const html = renderToStaticMarkup(
      <AskUserMessageView message={ask({ answer: "允许本次" })} onAnswer={() => {}} />,
    );
    expect(html).not.toContain("max-w-[720px]");
    expect(html).toContain("px-4");
  });

  // Long unbroken option text must wrap rather than force the card wider than
  // its column, which is what pushed content past the left viewport edge.
  test("constrains long option text with min-w-0", () => {
    const html = renderToStaticMarkup(<AskUserMessageView message={ask()} onAnswer={() => {}} />);
    expect(html).toContain("min-w-0");
  });
});
