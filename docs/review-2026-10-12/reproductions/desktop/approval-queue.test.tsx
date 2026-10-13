import { afterEach, expect, test } from "bun:test";
import React, { act } from "react";
import { createRoot } from "../../../../packages/desktop/node_modules/react-dom/client";
import {
  ensureMiniDom,
  flushMicrotasks,
} from "../../../../packages/desktop/src/renderer/test-utils/renderHook";
import { ChatView } from "../../../../packages/desktop/src/renderer/ChatView";
let root: any;
afterEach(async () => {
  await act(async () => {
    root?.unmount();
    await flushMicrotasks();
  });
  root = undefined;
});
function nodes(node: any): any[] {
  return Array.from(node?.childNodes ?? []).flatMap((child: any) => [child, ...nodes(child)]);
}
function props(node: any): any {
  const k = Object.keys(node).find((x) => x.startsWith("__reactProps$"));
  return k ? node[k] : {};
}
function text(value: any): string {
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map(text).join("");
  return value?.props ? text(value.props.children) : "";
}

test("CONFIRMED next queued approval inherits previous card's decided state and loses controls", async () => {
  ensureMiniDom();
  Object.assign(globalThis, {
    IntersectionObserver: class {
      observe() {}
      disconnect() {}
    },
  });
  Object.defineProperty(window, "codeshell", {
    configurable: true,
    writable: true,
    value: {
      sttAvailable: async () => ({ available: false }),
      listPluginCommands: async () => [],
      getProjectGitBranches: async () => ({ current: "main", branches: ["main"] }),
      onPluginCommandsChanged: () => () => {},
      log: () => {},
    },
  });
  const container = document.createElement("div");
  root = createRoot(container);
  const queue = [
    {
      requestId: "req-A",
      sessionId: "A",
      request: {
        toolName: "GenerateImage",
        args: { prompt: "first image" },
        description: "first image",
      },
    },
    {
      requestId: "req-B",
      sessionId: "A",
      request: {
        toolName: "GenerateImage",
        args: { prompt: "second image" },
        description: "second image",
      },
    },
  ];
  let count = 0;
  function Host() {
    const [current, setCurrent] = React.useState(0);
    return (
      <ChatView
        messages={[{ kind: "user", id: "u", text: "执行两个工具" }]}
        sendBucket="project::A"
        engineSessionId="A"
        onSend={() => {}}
        onStop={() => {}}
        busy
        activeProjectId="project"
        permissionMode="default"
        onPermissionChange={() => {}}
        goalEnabled={false}
        onGoalToggle={() => {}}
        modelOptions={[{ key: "test", label: "Test", provider: "test", supportsVision: true }]}
        activeModelKey="test"
        onModelChange={() => {}}
        contextTokens={0}
        projects={[]}
        onSelectProject={() => {}}
        onAddProject={() => {}}
        configurationTarget={{ sessionId: "A" }}
        configurationAvailable
        conversationRoot="/tmp"
        conversationRootId="root"
        draft=""
        onDraftChange={() => {}}
        attachments={[]}
        onAttachmentsChange={() => {}}
        pendingApproval={queue[current]}
        onApprovalDecide={() => {
          count++;
          setCurrent(1);
        }}
      />
    );
  }
  await act(async () => {
    root.render(<Host />);
    await flushMicrotasks();
  });
  const approve = nodes(container).find(
    (n) => n.tagName === "BUTTON" && text(props(n).children) === "仅本次批准",
  );
  if (!approve)
    throw new Error(
      "approve button missing; labels: " +
        nodes(container)
          .filter((n) => n.tagName === "BUTTON")
          .map((n) => text(props(n).children))
          .join("|"),
    );
  await act(async () => {
    props(approve).onClick();
    await flushMicrotasks();
  });
  expect(count).toBe(1);
  const card = nodes(container).find((n) => props(n)["data-request-id"] === "req-B");
  expect(card).toBeDefined();
  expect(nodes(card).some((n) => text(props(n).children).includes("second image"))).toBe(true);
  expect(
    nodes(card)
      .filter((n) => n.tagName === "BUTTON")
      .map((n) => text(props(n).children)),
  ).not.toContain("仅本次批准");
  expect(nodes(card).some((n) => text(props(n).children) === "已批准")).toBe(true);
});

test("CONFIRMED sticky question keeps old selected indexes and crashes after switching to a shorter question", async () => {
  ensureMiniDom();
  Object.defineProperty(window, "codeshell", {
    configurable: true,
    writable: true,
    value: {
      sttAvailable: async () => ({ available: false }),
      listPluginCommands: async () => [],
      getProjectGitBranches: async () => ({ current: "main", branches: ["main"] }),
      onPluginCommandsChanged: () => () => {},
      log: () => {},
    },
  });
  const container = document.createElement("div");
  root = createRoot(container);
  let select: any;
  function Host() {
    const [sid, setSid] = React.useState("A");
    select = setSid;
    return (
      <ChatView
        messages={[
          {
            kind: "ask_user",
            id: `ask-${sid}`,
            requestId: `ask-${sid}`,
            question: `问题 ${sid}`,
            multiSelect: true,
            options:
              sid === "A"
                ? [
                    { label: "A 一", description: "一" },
                    { label: "A 二", description: "二" },
                    { label: "A 三", description: "三" },
                  ]
                : [{ label: "B 唯一选项", description: "唯一" }],
          },
        ]}
        sendBucket={`project::${sid}`}
        engineSessionId={sid}
        onAskUserAnswer={() => {}}
        onSend={() => {}}
        onStop={() => {}}
        busy
        activeProjectId="project"
        permissionMode="default"
        onPermissionChange={() => {}}
        goalEnabled={false}
        onGoalToggle={() => {}}
        modelOptions={[{ key: "test", label: "Test", provider: "test", supportsVision: true }]}
        activeModelKey="test"
        onModelChange={() => {}}
        contextTokens={0}
        projects={[]}
        onSelectProject={() => {}}
        onAddProject={() => {}}
        configurationTarget={{ sessionId: sid }}
        configurationAvailable
        conversationRoot="/tmp"
        conversationRootId="root"
        draft=""
        onDraftChange={() => {}}
        attachments={[]}
        onAttachmentsChange={() => {}}
      />
    );
  }
  await act(async () => {
    root.render(<Host />);
    await flushMicrotasks();
  });
  const third = nodes(container).find(
    (n) => n.tagName === "LI" && text(props(n).children).includes("A 三"),
  );
  expect(third).toBeDefined();
  await act(async () => {
    props(third).onClick();
    await flushMicrotasks();
  });
  await act(async () => {
    select("B");
    await flushMicrotasks();
  });
  const submit = nodes(container).find(
    (n) => n.tagName === "BUTTON" && text(props(n).children) === "提交",
  );
  if (!submit)
    throw new Error(
      "submit missing; labels: " +
        nodes(container)
          .filter((n) => n.tagName === "BUTTON")
          .map((n) => text(props(n).children))
          .join("|"),
    );
  expect(props(submit).disabled).toBe(false);
  expect(() => props(submit).onClick()).toThrow();
});
