import { describe, expect, test } from "bun:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { AskUserMessageView } from "./AskUserMessageView";
import type { AskUserMessage } from "../types";
import { ensureMiniDom, flushMicrotasks } from "../test-utils/renderHook";
import { translate } from "../i18n/translate";

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

describe("AskUserMessageView missing question", () => {
  test("missing or blank unanswered questions show a diagnostic without answer controls", () => {
    for (const question of [undefined, "", " \n\t "]) {
      for (const asynchronous of [false, true]) {
        for (const options of [undefined, ask().options]) {
          const html = renderToStaticMarkup(
            <AskUserMessageView
              message={ask({ question, asynchronous, options })}
              onAnswer={() => {
                throw new Error("A missing question must not submit an answer");
              }}
            />,
          );
          expect(html).toContain('role="alert"');
          expect(html).toContain("未收到问题内容，暂时无法回答。");
          expect(html).not.toContain("<input");
          expect(html).not.toContain("<button");
          expect(html).not.toContain("允许本次");
        }
      }
    }
  });

  test("a resolved question preserves its recorded answer even when the question is blank", () => {
    const html = renderToStaticMarkup(
      <AskUserMessageView
        message={ask({ question: " ", answer: "问题已取消" })}
        onAnswer={() => {}}
      />,
    );
    expect(html).toContain("问题已取消");
    expect(html).not.toContain('role="alert"');
    expect(html).not.toContain("<input");
  });

  test("the diagnostic is available in Chinese and English", () => {
    expect(translate("zh", "msg.ask.questionUnavailable")).toBe("未收到问题内容，暂时无法回答。");
    expect(translate("en", "msg.ask.questionUnavailable")).toBe(
      "The question text is missing, so it cannot be answered yet.",
    );
  });
});

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

function descendants(node: Element): Element[] {
  return [node, ...Array.from(node.children).flatMap(descendants)];
}

function textOf(node: Node): string {
  if (node.nodeType === 3) return node.nodeValue ?? "";
  const children = Array.from(node.childNodes);
  return children.length ? children.map(textOf).join("") : (node.textContent ?? "");
}

function props(node: Element): Record<string, any> {
  const key = Object.keys(node).find((name) => name.startsWith("__reactProps$"));
  return key ? (node as unknown as Record<string, any>)[key] : {};
}

describe("AskUserMessageView asynchronous questions", () => {
  test("explains answer-later behavior and does not auto-focus the input", () => {
    const html = renderToStaticMarkup(
      <AskUserMessageView
        message={ask({ asynchronous: true, options: undefined })}
        onAnswer={() => {}}
      />,
    );
    expect(html).toContain("可以稍后回答，任务会继续");
    expect(html).toContain("稍后回答");
    expect(html).not.toContain("autofocus");
    const sync = renderToStaticMarkup(
      <AskUserMessageView message={ask({ options: undefined })} onAnswer={() => {}} />,
    );
    expect(sync).toContain("autofocus");
    expect(sync).not.toContain("稍后回答");
  });

  test("deferring preserves typed text and selected options without submitting an answer", async () => {
    ensureMiniDom();
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const answers: string[] = [];
    const click = async (node: Element) => {
      await act(async () => {
        props(node).onClick();
        await flushMicrotasks();
      });
    };
    const button = (label: string) =>
      descendants(container).find((node) => node.tagName === "BUTTON" && textOf(node) === label)!;
    try {
      await act(async () => {
        root.render(
          <AskUserMessageView
            message={ask({ asynchronous: true, multiSelect: true })}
            onAnswer={(_id, answer) => {
              answers.push(answer);
            }}
          />,
        );
        await flushMicrotasks();
      });
      const options = descendants(container).filter((node) => node.tagName === "LI");
      await click(options[0]!);
      await click(options[2]!);
      await act(async () => {
        const input = descendants(container).find((node) => node.tagName === "INPUT")!;
        props(input).onChange({ target: { value: "只处理文档" } });
      });
      await click(button("稍后回答"));
      expect(descendants(container).some((node) => node.tagName === "INPUT")).toBe(false);
      expect(answers).toEqual([]);
      await click(button("回答问题"));
      const input = descendants(container).find((node) => node.tagName === "INPUT")!;
      expect(props(input).value).toBe("只处理文档");
      await click(button("提交"));
      expect(answers).toEqual(["允许本次, 只处理文档"]);
    } finally {
      await act(async () => root.unmount());
      document.body.removeChild(container);
    }
  });

  test("failed sends retain drafts and allow retry while duplicate submissions are suppressed", async () => {
    ensureMiniDom();
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    let reject!: (error: Error) => void;
    const pending = new Promise<void>((_resolve, no) => {
      reject = no;
    });
    const answers: string[] = [];
    try {
      await act(async () => {
        root.render(
          <AskUserMessageView
            message={ask({ asynchronous: true, options: undefined })}
            onAnswer={(_id, answer) => {
              answers.push(answer);
              return answers.length === 1 ? pending : Promise.resolve();
            }}
          />,
        );
        await flushMicrotasks();
      });
      const input = () => descendants(container).find((node) => node.tagName === "INPUT")!;
      const answerButton = () =>
        descendants(container).find(
          (node) => node.tagName === "BUTTON" && textOf(node) === "回答",
        )!;
      await act(async () => {
        props(input()).onChange({ target: { value: "先检查测试" } });
      });
      await act(async () => {
        props(answerButton()).onClick();
        props(answerButton()).onClick();
        await flushMicrotasks();
      });
      expect(answers).toEqual(["先检查测试"]);
      expect(textOf(container)).toContain("正在提交");
      await act(async () => {
        reject(new Error("Connection interrupted"));
        await flushMicrotasks();
      });
      expect(textOf(container)).toContain("回答提交失败，请重试");
      expect(props(input()).value).toBe("先检查测试");
      expect(props(answerButton()).disabled).toBe(false);
      await act(async () => {
        props(answerButton()).onClick();
        await flushMicrotasks();
      });
      expect(answers).toEqual(["先检查测试", "先检查测试"]);
      expect(textOf(container)).not.toContain("回答提交失败");
    } finally {
      await act(async () => root.unmount());
      document.body.removeChild(container);
    }
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
