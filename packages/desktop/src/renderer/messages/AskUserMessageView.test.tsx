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
    const html = renderToStaticMarkup(
      <AskUserMessageView message={ask()} onAnswer={() => {}} />,
    );
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
