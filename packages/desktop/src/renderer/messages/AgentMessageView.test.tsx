import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { ensureMiniDom, flushMicrotasks } from "../test-utils/renderHook";
import { AgentMessageView } from "./AgentMessageView";
import type { AgentMessage, ToolMessage } from "../types";

function tool(id: string, name = "Read", over: Partial<ToolMessage> = {}): ToolMessage {
  return {
    kind: "tool",
    id,
    toolName: name,
    args: JSON.stringify({ file_path: "/x/schema.ts" }),
    status: "succeeded",
    startedAt: 0,
    endedAt: 10,
    durationMs: 10,
    result: "ok",
    ...over,
  };
}

function agent(over: Partial<AgentMessage> = {}): AgentMessage {
  return {
    kind: "agent",
    id: "A",
    name: "Sub",
    description: "doing work",
    done: false,
    startedAt: 0,
    toolCalls: [],
    textBuffer: "",
    toolCount: 0,
    ...over,
  };
}

function retainedTools(): ToolMessage[] {
  return Array.from({ length: 38 }, (_, index) =>
    tool(`retained-${index}`, index === 37 ? "Bash" : "Read", {
      args: JSON.stringify(
        index === 37 ? { command: "bun test retained-operation" } : { file_path: "/x/schema.ts" },
      ),
      status: index === 37 ? "running" : "succeeded",
      result: index === 37 ? undefined : "Retained operation result",
    }),
  );
}

function reactPropsOf(node: unknown): Record<string, any> {
  const current = node as Record<string, any>;
  const key = Object.keys(current).find((name) => name.startsWith("__reactProps$"));
  return key ? current[key] : {};
}

function findElements(node: unknown, tagName: string): any[] {
  const current = node as { tagName?: string; childNodes?: unknown[] };
  return [
    ...(current.tagName === tagName ? [current] : []),
    ...(current.childNodes ?? []).flatMap((child) => findElements(child, tagName)),
  ];
}

function renderedText(node: unknown): string {
  const current = node as {
    childNodes?: unknown[];
    nodeValue?: string;
    nodeType?: number;
    textContent?: string;
  };
  if (current.nodeType === 3) return current.nodeValue ?? current.textContent ?? "";
  const children = Array.from(current.childNodes ?? []);
  if (children.length === 0) return current.textContent ?? "";
  return children.map(renderedText).join("");
}

function agentHeader(container: unknown, id = "A"): any {
  return findElements(container, "BUTTON").find(
    (node) => reactPropsOf(node)["aria-controls"] === `agent-body-${id}`,
  );
}

function agentBody(container: unknown, id = "A"): any {
  return findElements(container, "DIV").find(
    (node) => reactPropsOf(node).id === `agent-body-${id}`,
  );
}

function toolCards(container: unknown): any[] {
  return findElements(container, "DIV").filter(
    (node) => reactPropsOf(node)["data-message-kind"] === "tool",
  );
}

async function click(node: unknown): Promise<void> {
  await act(async () => {
    reactPropsOf(node).onClick({ stopPropagation() {} });
    await flushMicrotasks();
  });
}

describe("AgentMessageView header", () => {
  test("running agent header shows status without tool counts or live operations", () => {
    const html = renderToStaticMarkup(
      <AgentMessageView
        message={agent({
          toolCalls: retainedTools(),
          toolCount: 38,
        })}
      />,
    );
    expect(html).toContain("运行中");
    expect(html).toContain("doing work");
    expect(html).not.toContain("正在读取");
    expect(html).not.toContain("schema.ts");
    expect(html).not.toContain("bun test retained-operation");
    expect(html).not.toContain("次工具调用");
    expect(html).not.toContain("tools");
    expect(html).not.toContain('data-message-kind="tool"');
  });

  test("renders the agent_type badge when present", () => {
    const html = renderToStaticMarkup(
      <AgentMessageView message={agent({ agentType: "explorer" })} />,
    );
    expect(html).toContain("explorer");
  });

  test("a failed background agent shows failure instead of running activity", () => {
    const html = renderToStaticMarkup(
      <AgentMessageView
        message={agent({
          backgrounded: true,
          error: "Unable to continue.",
          toolCalls: [tool("t1", "Read", { status: "running" })],
          toolCount: 1,
        })}
      />,
    );
    expect(html).toContain("失败");
    expect(html).not.toContain("运行中");
    expect(html).not.toContain("正在读取");
    expect(html).not.toContain("次工具调用");
  });
});

describe("AgentMessageView details", () => {
  let root: Root | null;
  let container: HTMLElement;

  beforeEach(() => {
    ensureMiniDom();
    container = document.createElement("div") as unknown as HTMLElement;
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root?.unmount();
      await flushMicrotasks();
    });
    root = null;
  });

  async function render(...messages: AgentMessage[]): Promise<void> {
    await act(async () => {
      root?.render(
        <>
          {messages.map((message) => (
            <AgentMessageView key={message.id} message={message} />
          ))}
        </>,
      );
      await flushMicrotasks();
    });
  }

  test("opens the task and waiting state without mounting retained tool records", async () => {
    const description = "Inspect the schema and its callers.\nThen verify the affected tests.";
    const tools = retainedTools();
    const message = agent({ description, toolCalls: tools, toolCount: tools.length });
    await render(message);

    expect(reactPropsOf(agentHeader(container)).disabled).toBe(false);
    expect(reactPropsOf(agentHeader(container))["aria-expanded"]).toBe(false);
    expect(agentBody(container)).toBeUndefined();
    expect(toolCards(container)).toHaveLength(0);

    await click(agentHeader(container));

    expect(reactPropsOf(agentHeader(container))["aria-expanded"]).toBe(true);
    const body = agentBody(container);
    expect(renderedText(body)).toContain(description);
    expect(renderedText(body)).toContain("子代理运行中，完成后会在这里显示结果。");
    expect(renderedText(body)).not.toContain("执行过程");
    expect(renderedText(body)).not.toContain("bun test retained-operation");
    expect(renderedText(body)).not.toContain("Retained operation result");
    expect(toolCards(body)).toHaveLength(0);
    expect(findElements(body, "PRE")).toHaveLength(0);
    expect(message.toolCalls).toBe(tools);
    expect(message.toolCalls).toHaveLength(38);
    expect(message.toolCount).toBe(38);

    await click(agentHeader(container));

    expect(agentBody(container)).toBeUndefined();
    expect(toolCards(container)).toHaveLength(0);

    const emptyRunning = agent({ description: "", toolCalls: tools, toolCount: tools.length });
    await render(emptyRunning);
    await click(agentHeader(container));
    expect(reactPropsOf(agentHeader(container))["aria-expanded"]).toBe(true);
    expect(renderedText(agentBody(container))).toContain("子代理运行中，完成后会在这里显示结果。");
    await render({ ...emptyRunning, done: true });
    expect(reactPropsOf(agentHeader(container)).disabled).toBe(true);
    expect(reactPropsOf(agentHeader(container))["aria-expanded"]).toBe(false);
    expect(agentBody(container)).toBeUndefined();
    expect(emptyRunning.toolCalls).toHaveLength(38);
  });

  test("shows the formatted result and error without exposing commands or tool output", async () => {
    const command = "bun test packages/core/src/engine.test.ts";
    const result = "3 tests passed\nAll assertions verified";
    await render(
      agent({
        done: true,
        text: "**Verified the engine tests.**",
        error: "The optional follow-up was interrupted.",
        toolCalls: [tool("bash", "Bash", { args: JSON.stringify({ command }), result })],
        toolCount: 1,
      }),
    );

    expect(renderedText(container)).not.toContain("Verified the engine tests.");
    expect(renderedText(container)).not.toContain("The optional follow-up was interrupted.");
    await click(agentHeader(container));
    const body = agentBody(container);
    expect(renderedText(body)).toContain("Verified the engine tests.");
    expect(renderedText(body)).toContain("The optional follow-up was interrupted.");
    expect(renderedText(agentHeader(container))).toContain("失败");
    expect(renderedText(body)).not.toContain("执行过程");
    expect(findElements(body, "STRONG").map(renderedText)).toContain("Verified the engine tests.");
    expect(renderedText(body)).not.toContain(result);
    expect(renderedText(body)).not.toContain(command);
    expect(toolCards(body)).toHaveLength(0);
    expect(findElements(body, "PRE")).toHaveLength(0);
    expect(reactPropsOf(agentHeader(container))["aria-expanded"]).toBe(true);
  });

  test("keeps the summary open through hidden tool updates and final result completion", async () => {
    const initialTool = tool("bash", "Bash", {
      args: "{",
      argsLive: { command: "bun test" },
      result: undefined,
      status: "running",
    });
    const initial = agent({
      text: "Checking ",
      textBuffer: "the schema.",
      toolCalls: [initialTool],
      toolCount: 1,
    });
    await render(initial);
    await click(agentHeader(container));
    expect(renderedText(agentBody(container))).toContain("Checking the schema.");
    expect(toolCards(container)).toHaveLength(0);

    const streamingTool = {
      ...initialTool,
      argsLive: { command: "bun test packages/core", cwd: "/workspace/project" },
      result: "Running 2 tests…",
    };
    await render({ ...initial, toolCalls: [streamingTool] });
    expect(reactPropsOf(agentHeader(container))["aria-expanded"]).toBe(true);
    expect(renderedText(agentBody(container))).toContain("Checking the schema.");
    expect(renderedText(agentBody(container))).not.toContain("bun test packages/core");
    expect(renderedText(agentBody(container))).not.toContain("Running 2 tests…");
    expect(renderedText(agentBody(container))).not.toContain("/workspace/project");
    expect(toolCards(container)).toHaveLength(0);

    await render({
      ...initial,
      done: true,
      text: "Checks complete. ",
      textBuffer: "All constraints hold.",
      toolCalls: [
        {
          ...streamingTool,
          args: JSON.stringify(streamingTool.argsLive),
          argsLive: undefined,
          status: "succeeded",
          result: "2 tests passed",
        },
      ],
    });

    const body = agentBody(container);
    expect(reactPropsOf(agentHeader(container))["aria-expanded"]).toBe(true);
    expect(renderedText(agentHeader(container))).toContain("已完成");
    expect(renderedText(body)).toContain("Checks complete. All constraints hold.");
    expect(renderedText(body)).not.toContain("bun test packages/core");
    expect(renderedText(body)).not.toContain("2 tests passed");
    expect(toolCards(body)).toHaveLength(0);
  });

  test("still opens text-only streaming output and error-only agents", async () => {
    await render(agent({ text: "Already read the schema. ", textBuffer: "Checking callers." }));
    await click(agentHeader(container));
    expect(renderedText(agentBody(container))).toContain(
      "Already read the schema. Checking callers.",
    );
    expect(toolCards(container)).toHaveLength(0);

    await render(
      agent({ id: "failed", description: "", done: true, error: "Unable to start the task." }),
    );
    expect(reactPropsOf(agentHeader(container, "failed")).disabled).toBe(false);
    await click(agentHeader(container, "failed"));
    expect(renderedText(agentBody(container, "failed"))).toContain("Unable to start the task.");
  });

  test("expanding and updating one summary preserves independent sibling disclosure", async () => {
    const first = agent({
      text: "First result.",
      toolCalls: [tool("first-tool", "Bash", { args: '{"command":"bun test first"}' })],
      toolCount: 1,
    });
    const sibling = agent({
      id: "B",
      name: "Other agent",
      text: "Second result.",
      toolCalls: [tool("second-tool", "Bash", { args: '{"command":"bun test second"}' })],
      toolCount: 1,
    });
    await render(first, sibling);
    await click(agentHeader(container));
    await render(
      {
        ...first,
        done: true,
        text: "First suite verified.",
        toolCalls: [{ ...first.toolCalls[0], result: "first raw tool result" }],
      },
      sibling,
    );

    expect(renderedText(agentBody(container))).toContain("First suite verified.");
    expect(renderedText(agentBody(container))).not.toContain("first raw tool result");
    expect(agentBody(container, "B")).toBeUndefined();
    expect(reactPropsOf(agentHeader(container, "B"))["aria-expanded"]).toBe(false);

    await click(agentHeader(container, "B"));
    expect(renderedText(agentBody(container, "B"))).toContain("Second result.");
    expect(renderedText(agentBody(container, "B"))).not.toContain("First suite verified.");
    expect(renderedText(agentBody(container, "B"))).not.toContain("bun test second");
    expect(renderedText(agentBody(container))).not.toContain("Second result.");
    expect(reactPropsOf(agentHeader(container))["aria-expanded"]).toBe(true);
    expect(toolCards(container)).toHaveLength(0);
  });
});
