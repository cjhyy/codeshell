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

test("手机确认展示 worker 给出的统一绝对截止时间", () => {
  const expiresAt = new Date("2026-10-30T04:16:02Z").getTime();
  const html = renderToStaticMarkup(
    <ApprovalCard approval={{ ...base, expiresAt }} onRespond={() => {}} />,
  );
  expect(html).toContain("各端共用此期限");
  expect(html).toContain(
    new Date(expiresAt).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }),
  );
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

const modelQuestion: PendingApproval = {
  requestId: "m1",
  toolName: "__ask_user__",
  description: "哪里的样式奇怪？",
  summary: "哪里的样式奇怪？",
  risk: "low",
  pathScoped: false,
  options: ["工作台画布", "对照审阅页"],
  skippable: true,
  keepWaitable: true,
  recommended: "对照审阅页",
  expiresAt: Date.now() + 90_000,
};

test("模型提问显示倒计时、一直等、跳过与推荐标记", () => {
  const html = renderToStaticMarkup(
    <ApprovalCard approval={modelQuestion} onRespond={() => {}} onKeepWaiting={() => {}} />,
  );
  expect(html).toMatch(/1:[23]\d 后未回答将自动选择「对照审阅页」/);
  expect(html).toContain("一直等");
  expect(html).toContain("推荐");
  expect(html).toContain("跳过");
  expect(html).not.toContain(">取消<");
});

test("改为一直等后不再显示倒计时；权限类提问仍是取消", () => {
  const kept = renderToStaticMarkup(
    <ApprovalCard
      approval={{ ...modelQuestion, keepWaitable: false, expiresAt: undefined }}
      onRespond={() => {}}
      onKeepWaiting={() => {}}
    />,
  );
  expect(kept).not.toContain("一直等");
  expect(kept).not.toContain("后未回答");
  const permission = renderToStaticMarkup(
    <ApprovalCard
      approval={{ ...modelQuestion, skippable: false, keepWaitable: false, recommended: undefined }}
      onRespond={() => {}}
    />,
  );
  expect(permission).not.toContain("跳过");
});

test("开始输入自定义回答会自动改为一直等（只触发一次）", async () => {
  ensureMiniDom();
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  let kept = 0;
  try {
    await act(async () => {
      root.render(
        <ApprovalCard
          approval={modelQuestion}
          onRespond={() => {}}
          onKeepWaiting={() => {
            kept++;
          }}
        />,
      );
      await flushMicrotasks();
    });
    const textarea = (function find(node: any): any {
      if (node?.tagName === "TEXTAREA") return node;
      for (const child of node?.childNodes ?? []) {
        const hit = find(child);
        if (hit) return hit;
      }
      return undefined;
    })(container);
    const key = Object.keys(textarea).find((k) => k.startsWith("__reactProps$"))!;
    await act(async () => {
      textarea[key].onChange({ target: { value: "a" } });
      textarea[key].onChange({ target: { value: "ab" } });
      await flushMicrotasks();
    });
    expect(kept).toBe(1);
  } finally {
    await act(async () => root.unmount());
    document.body.removeChild(container);
  }
});
