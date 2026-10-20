import { expect, test } from "bun:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { askUserTool, askUserAsyncTool } from "../../../packages/core/src/tool-system/builtin/ask-user.ts";
import { extractAskUserOptions } from "../../../packages/web/src/lib/messageMappers.ts";
import { ApprovalCard } from "../../../packages/desktop/src/mobile/components/ApprovalCard.tsx";
import { ensureMiniDom, flushMicrotasks } from "../../../packages/web/src/test-utils/renderHook.tsx";
import type { AskUserOptions, ToolContext } from "../../../packages/core/src/tool-system/context.ts";

const choices = [
  { label: "Core", description: "Review the engine" },
  { label: "Web", description: "Review the web client" },
];
const question = "Which modules should be reviewed? Select all that apply.";

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

async function toolOptions(asynchronous: boolean, multiSelect: boolean): Promise<AskUserOptions> {
  let received: AskUserOptions | undefined;
  const callback = async (q: string, opts?: AskUserOptions): Promise<string> => {
    expect(q).toBe(question);
    received = opts;
    return asynchronous ? "Question displayed" : "Core, Web";
  };
  const context = { askUser: callback, askUserAsync: callback } as ToolContext;
  const tool = asynchronous ? askUserAsyncTool : askUserTool;
  const result = await tool({ question, options: choices, multiSelect }, context);
  expect(result).toBe(asynchronous ? "Question displayed" : "Core, Web");
  expect(received?.options).toEqual(choices);
  return received!;
}

test("real sync and async tools preserve multiSelect, while the phone mapper loses it", async () => {
  for (const asynchronous of [false, true]) {
    const opts = await toolOptions(asynchronous, true);
    expect(opts.multiSelect).toBe(true);
    // AgentServer emits the question and its rendering options in request.args.
    const wireArgs = { question, ...opts, ...(asynchronous ? { asynchronous: true } : {}) };
    const projected = extractAskUserOptions(wireArgs);
    expect(projected).toEqual({ options: ["Core", "Web"], optionsOnly: false });
    expect(Object.hasOwn(projected!, "multiSelect")).toBe(false);
  }
});

test("real Mobile card immediately answers the first option for both multi and single choice", async () => {
  ensureMiniDom();
  for (const multiSelect of [true, false]) {
    const opts = await toolOptions(false, multiSelect);
    const mapped = extractAskUserOptions({ question, ...opts })!;
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const responses: unknown[][] = [];
    try {
      await act(async () => {
        root.render(<ApprovalCard approval={{
          requestId: `question-${multiSelect}`,
          toolName: "__ask_user__",
          description: question,
          summary: question,
          risk: "low",
          pathScoped: false,
          ...mapped,
        }} onRespond={(...args) => { responses.push(args); }} />);
        await flushMicrotasks();
      });
      expect(responses).toEqual([]);
      expect(descendants(container).filter((node) => props(node).role === "checkbox")).toHaveLength(0);
      const core = descendants(container).find((node) => node.tagName === "BUTTON" && textOf(node).includes("Core"))!;
      expect(core).toBeDefined();
      await act(async () => {
        props(core).onClick();
        await flushMicrotasks();
      });
      // For multiSelect:true this settles the question before the second choice;
      // for multiSelect:false it is the expected single-choice control.
      expect(responses).toEqual([["approve", { answer: "Core" }]]);
    } finally {
      await act(async () => root.unmount());
      document.body.removeChild(container);
    }
  }
});

test("manual combined free text remains a workaround for an ordinary multi-choice question", async () => {
  ensureMiniDom();
  const opts = await toolOptions(false, true);
  const mapped = extractAskUserOptions({ question, ...opts })!;
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const responses: unknown[][] = [];
  try {
    await act(async () => {
      root.render(<ApprovalCard approval={{
        requestId: "manual-answer",
        toolName: "__ask_user__",
        description: question,
        summary: question,
        risk: "low",
        pathScoped: false,
        ...mapped,
      }} onRespond={(...args) => { responses.push(args); }} />);
      await flushMicrotasks();
    });
    const input = descendants(container).find((node) => node.tagName === "TEXTAREA")!;
    await act(async () => { props(input).onChange({ target: { value: "Core, Web" } }); });
    const submit = descendants(container).find((node) => node.tagName === "BUTTON" && props(node).disabled === false)!;
    expect(submit).toBeDefined();
    await act(async () => { props(submit).onClick(); await flushMicrotasks(); });
    expect(responses).toEqual([["approve", { answer: "Core, Web" }]]);
  } finally {
    await act(async () => root.unmount());
    document.body.removeChild(container);
  }
});
