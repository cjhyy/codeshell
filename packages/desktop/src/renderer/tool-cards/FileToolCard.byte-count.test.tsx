import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ToolCard } from "./index";
import type { ToolMessage } from "../types";
import { ensureMiniDom, flushMicrotasks } from "../test-utils/renderHook";

function textOf(node: any): string {
  return node.nodeType === 3
    ? (node.nodeValue ?? node.textContent ?? "")
    : node.childNodes?.length
      ? Array.from(node.childNodes).map(textOf).join("")
      : (node.textContent ?? "");
}

function propsOf(node: any): Record<string, any> {
  const key = Object.keys(node).find((key) => key.startsWith("__reactProps$"));
  return key ? node[key] : {};
}

function find(node: any, attribute: string): any {
  if (propsOf(node)[attribute] === "") return node;
  for (const child of node.childNodes ?? []) {
    const match = find(child, attribute);
    if (match) return match;
  }
  return undefined;
}

describe("actual Write card byte labels", () => {
  let root: Root;
  let container: HTMLElement;
  beforeEach(() => {
    ensureMiniDom();
    container = document.createElement("div");
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => {
      root.unmount();
      await flushMicrotasks();
    });
  });
  const message = (toolName: string, content: unknown): ToolMessage => ({
    kind: "tool",
    id: "owned-write-card",
    toolName,
    args: JSON.stringify({ file_path: "owned.txt", content }),
    status: "succeeded",
    startedAt: 1,
  });
  const render = async (value: ToolMessage) => {
    await act(async () => {
      root.render(<ToolCard message={value} />);
      await flushMicrotasks();
    });
    const heading = find(container, "data-tool-heading");
    expect(heading).toBeDefined();
    return heading;
  };

  test.each([
    ["中文", 6],
    ["😀", 4],
    ["a\r\n中😀", 10],
    ["ASCII", 5],
    ["", 0],
  ] as const)("counts UTF-8 bytes for %j", async (content, bytes) => {
    const value = message("Write", content);
    const heading = await render(value);
    expect(textOf(heading)).toContain(`(${bytes}B)`);
    await act(async () => {
      propsOf(heading).onClick({ stopPropagation() {}, currentTarget: heading });
      await flushMicrotasks();
    });
    expect(textOf(container)).toContain(content);
    expect(JSON.parse(value.args).content).toBe(content);
  });

  test("counts replacement bytes for a lone surrogate without changing tool arguments", async () => {
    const value = message("Write", "\ud83d");
    expect(textOf(await render(value))).toContain("(3B)");
    expect(JSON.parse(value.args).content).toBe("\ud83d");
  });

  test("updates the label when live arguments supersede the initial content", async () => {
    const initial = message("FileWrite", "ASCII");
    expect(textOf(await render(initial))).toContain("(5B)");
    const live = { ...initial, argsLive: { file_path: "owned.txt", content: "中文😀" } };
    expect(textOf(await render(live))).toContain("(10B)");
    expect(textOf(await render({ ...live, argsLive: undefined }))).toContain("(5B)");
    expect(JSON.parse(initial.args).content).toBe("ASCII");
  });

  test.each(["Read", "Edit"])("does not add a byte label to %s", async (toolName) => {
    expect(textOf(await render(message(toolName, "中文")))).not.toMatch(/\(\d+B\)/);
  });

  test.each([undefined, 123])(
    "does not invent bytes for non-string content %j",
    async (content) => {
      expect(textOf(await render(message("Write", content)))).not.toMatch(/\(\d+B\)/);
    },
  );
});
