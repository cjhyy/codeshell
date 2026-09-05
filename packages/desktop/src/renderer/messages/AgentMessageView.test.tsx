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
  test("running agent header shows its live activity", () => {
    const html = renderToStaticMarkup(
      <AgentMessageView
        message={agent({
          toolCalls: [tool("t1", "Read", { status: "running" })],
          toolCount: 1,
        })}
      />,
    );
    expect(html).toContain("正在读取");
    expect(html).toContain("schema.ts");
    expect(html).not.toContain("1 tools");
  });

  test("renders the agent_type badge when present", () => {
    const html = renderToStaticMarkup(
      <AgentMessageView message={agent({ agentType: "explorer" })} />,
    );
    expect(html).toContain("explorer");
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

  test("opens tools-only activity in arrival order and mounts details only while expanded", async () => {
    const description = "Inspect the schema and its callers.\nThen verify the affected tests.";
    await render(
      agent({
        description,
        toolCalls: [
          tool("read-first", "Read"),
          tool("search-second", "Grep", { args: '{"pattern":"schema"}' }),
          tool("run-last", "Bash", { args: '{"command":"bun test"}', status: "running" }),
        ],
        toolCount: 3,
      }),
    );

    expect(reactPropsOf(agentHeader(container)).disabled).toBe(false);
    expect(reactPropsOf(agentHeader(container))["aria-expanded"]).toBe(false);
    expect(agentBody(container)).toBeUndefined();
    expect(toolCards(container)).toHaveLength(0);

    await click(agentHeader(container));

    expect(reactPropsOf(agentHeader(container))["aria-expanded"]).toBe(true);
    const body = agentBody(container);
    expect(renderedText(body)).toContain(description);
    expect(toolCards(body).map((node) => reactPropsOf(node)["data-tool-name"])).toEqual([
      "Read",
      "Grep",
      "Bash",
    ]);
    expect(findElements(body, "PRE")).toHaveLength(0);

    await click(agentHeader(container));

    expect(agentBody(container)).toBeUndefined();
    expect(toolCards(container)).toHaveLength(0);
  });

  test("opens a Bash command and result alongside the agent's final output and error", async () => {
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
    expect(findElements(body, "STRONG").map(renderedText)).toContain("Verified the engine tests.");
    expect(renderedText(body)).not.toContain(result);

    await click(findElements(toolCards(body)[0], "BUTTON")[0]);

    expect(findElements(body, "PRE").map(renderedText)).toEqual([command, result]);
    expect(reactPropsOf(agentHeader(container))["aria-expanded"]).toBe(true);
  });

  test("keeps an open tool updated as arguments, output, and completion arrive", async () => {
    const initialTool = tool("bash", "Bash", {
      args: "{",
      argsLive: { command: "bun test" },
      result: undefined,
      status: "running",
    });
    const initial = agent({ toolCalls: [initialTool], toolCount: 1 });
    await render(initial);
    await click(agentHeader(container));
    await click(findElements(toolCards(agentBody(container))[0], "BUTTON")[0]);
    expect(findElements(agentBody(container), "PRE").map(renderedText)).toEqual(["bun test"]);

    const streamingTool = {
      ...initialTool,
      argsLive: { command: "bun test packages/core", cwd: "/workspace/project" },
      result: "Running 2 tests…",
    };
    await render({ ...initial, toolCalls: [streamingTool] });
    expect(findElements(agentBody(container), "PRE").map(renderedText)).toEqual([
      "bun test packages/core",
      "Running 2 tests…",
    ]);
    expect(renderedText(agentBody(container))).toContain("/workspace/project");

    await render({
      ...initial,
      done: true,
      text: "Checks complete.",
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
    expect(reactPropsOf(findElements(toolCards(body)[0], "BUTTON")[0])["aria-expanded"]).toBe(true);
    expect(findElements(body, "PRE").map(renderedText)).toEqual([
      "bun test packages/core",
      "2 tests passed",
    ]);
    expect(renderedText(body)).toContain("Checks complete.");
  });

  test("still opens text-only streaming output and error-only agents", async () => {
    await render(agent({ text: "Already read the schema. ", textBuffer: "Checking callers." }));
    await click(agentHeader(container));
    expect(renderedText(agentBody(container))).toContain(
      "Already read the schema. Checking callers.",
    );
    expect(toolCards(container)).toHaveLength(0);

    await render(agent({ id: "failed", done: true, error: "Unable to start the task." }));
    expect(reactPropsOf(agentHeader(container, "failed")).disabled).toBe(false);
    await click(agentHeader(container, "failed"));
    expect(renderedText(agentBody(container, "failed"))).toContain("Unable to start the task.");
  });

  test("expanding and updating one agent leaves sibling activity independent", async () => {
    const first = agent({
      toolCalls: [tool("first-tool", "Bash", { args: '{"command":"bun test first"}' })],
      toolCount: 1,
    });
    const sibling = agent({
      id: "B",
      name: "Other agent",
      toolCalls: [tool("second-tool", "Bash", { args: '{"command":"bun test second"}' })],
      toolCount: 1,
    });
    await render(first, sibling);
    await click(agentHeader(container));
    await click(findElements(toolCards(agentBody(container))[0], "BUTTON")[0]);
    await render(
      { ...first, toolCalls: [{ ...first.toolCalls[0], result: "first suite passed" }] },
      sibling,
    );

    expect(renderedText(agentBody(container))).toContain("first suite passed");
    expect(agentBody(container, "B")).toBeUndefined();
    expect(reactPropsOf(agentHeader(container, "B"))["aria-expanded"]).toBe(false);

    await click(agentHeader(container, "B"));
    expect(renderedText(agentBody(container, "B"))).toContain("bun test second");
    expect(renderedText(agentBody(container, "B"))).not.toContain("first suite passed");
    expect(renderedText(agentBody(container))).not.toContain("bun test second");
  });
});
