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

describe("actual tool-card Unicode summaries", () => {
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

  test.each([
    ["Read", "file_path", 70],
    ["PowerShell", "command", 80],
    ["Agent", "description", 80],
    ["Bash", "command", 90],
  ] as const)(
    "%s shows a valid summary and preserves the complete tool identity and args",
    async (toolName, key, max) => {
      const value = "x".repeat(max - 2) + "😀tail";
      const message: ToolMessage = {
        kind: "tool",
        id: "owned-tool-😀-完整标识",
        toolName,
        args: JSON.stringify({ [key]: value }),
        status: "succeeded",
        startedAt: 1,
      };
      const selected: ToolMessage[] = [];
      await act(async () => {
        root.render(<ToolCard message={message} onSelect={(item) => selected.push(item)} />);
        await flushMicrotasks();
      });
      const heading = find(container, "data-tool-heading");
      expect(heading).toBeDefined();
      const summary = textOf(heading);
      expect(summary.isWellFormed()).toBe(true);
      expect(summary).toContain("x".repeat(max - 2) + "…");
      expect(new TextDecoder().decode(new TextEncoder().encode(summary))).toBe(summary);
      await act(async () => {
        propsOf(heading).onClick({ stopPropagation() {}, currentTarget: heading });
        await flushMicrotasks();
      });
      expect(textOf(container)).toContain(value);
      propsOf(find(container, "data-tool-card")).onClick();
      expect(selected).toEqual([message]);
      expect(selected[0]).toBe(message);
      expect(selected[0].id).toBe("owned-tool-😀-完整标识");
      expect(JSON.parse(selected[0].args)[key]).toBe(value);
    },
  );
});
