import { test, expect } from "bun:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { ApprovalCard } from "./ApprovalCard";
import type { PendingApproval } from "@cjhyy/code-shell-web";
import { ensureMiniDom, flushMicrotasks } from "../../renderer/test-utils/renderHook";

const base: PendingApproval = {
  requestId: "r1",
  toolName: "Bash",
  description: "运行命令",
  summary: "rm -rf /tmp/x",
  risk: "high",
  pathScoped: false,
};

test("常规审批显示工具名/风险/允许拒绝", () => {
  const html = renderToStaticMarkup(<ApprovalCard approval={base} onRespond={() => {}} />);
  expect(html).toContain("Bash");
  expect(html).toContain("高风险");
  expect(html).toContain("rm -rf /tmp/x");
  expect(html).toContain("允许");
  expect(html).toContain("拒绝");
  expect(html).toContain("记住范围");
});

test("路径类工具显示路径范围(记住时)", () => {
  // pathScope chips only render when scope !== once; initial scope is once, so
  // they're hidden initially — assert the scope chips exist at least.
  const html = renderToStaticMarkup(
    <ApprovalCard
      approval={{ ...base, toolName: "Edit", pathScoped: true }}
      onRespond={() => {}}
    />,
  );
  expect(html).toContain("Edit");
  expect(html).toContain("本项目");
});

test("AskUser 审批渲染选项按钮", () => {
  const html = renderToStaticMarkup(
    <ApprovalCard
      approval={{ ...base, toolName: "AskUser", options: ["选项甲", "选项乙"], optionsOnly: false }}
      onRespond={() => {}}
    />,
  );
  expect(html).toContain("选项甲");
  expect(html).toContain("选项乙");
  expect(html).toContain("或输入自定义回答");
});

test("optionsOnly 不出自由输入", () => {
  const html = renderToStaticMarkup(
    <ApprovalCard
      approval={{ ...base, toolName: "AskUser", options: ["A"], optionsOnly: true }}
      onRespond={() => {}}
    />,
  );
  expect(html).not.toContain("或输入自定义回答");
});

test("自由回答问题无需选项且不显示权限范围", () => {
  const html = renderToStaticMarkup(
    <ApprovalCard
      approval={{
        ...base,
        toolName: "__ask_user__",
        asynchronous: true,
        description: "需要检查哪个模块？",
        summary: '{"question":"需要检查哪个模块？","asynchronous":true}',
      }}
      onRespond={() => {}}
    />,
  );
  expect(html).toContain("textarea");
  expect(html).toContain("可以稍后回答，任务会继续");
  expect(html).toContain("稍后回答");
  expect(html).not.toContain("记住范围");
  expect(html).not.toContain("autofocus");
  expect(html).not.toContain("&quot;asynchronous&quot;");
  expect(html).toContain("需要检查哪个模块？");
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

test("手机异步自由回答保留草稿，稍后不会提交或拒绝，恢复后发送真实回答", async () => {
  ensureMiniDom();
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const responses: unknown[][] = [];
  const button = (label: string) =>
    descendants(container).find(
      (node) => node.tagName === "BUTTON" && textOf(node).includes(label),
    )!;
  const textarea = () => descendants(container).find((node) => node.tagName === "TEXTAREA");
  const click = async (node: Element) => {
    await act(async () => {
      props(node).onClick();
      await flushMicrotasks();
    });
  };
  try {
    await act(async () => {
      root.render(
        <ApprovalCard
          approval={{
            ...base,
            toolName: "__ask_user__",
            asynchronous: true,
            description: "需要检查哪个模块？",
            summary: "需要检查哪个模块？",
          }}
          onRespond={(...args) => {
            responses.push(args);
          }}
        />,
      );
      await flushMicrotasks();
    });
    await act(async () => {
      props(textarea()!).onChange({ target: { value: "  检查登录模块  " } });
    });
    await click(button("稍后回答"));
    expect(textarea()).toBeUndefined();
    expect(responses).toEqual([]);
    expect(textOf(container)).toContain("需要检查哪个模块？");
    await click(button("回答问题"));
    expect(props(textarea()!).value).toBe("  检查登录模块  ");
    await click(
      descendants(container).find(
        (node) => node.tagName === "BUTTON" && props(node).disabled === false,
      )!,
    );
    expect(responses).toEqual([["approve", { answer: "检查登录模块" }]]);
  } finally {
    await act(async () => root.unmount());
    document.body.removeChild(container);
  }
});
