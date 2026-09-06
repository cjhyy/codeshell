import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ToolOutputBlock } from "./ToolOutputBlock";
import { FileToolCard } from "./FileToolCard";
import { GenericToolCard } from "./GenericToolCard";
import { BashToolCard } from "./BashToolCard";
import { ToastProvider } from "../ui/ToastProvider";
import { ensureMiniDom, flushMicrotasks } from "../test-utils/renderHook";
import type { ToolMessage } from "../types";

function props(node: any): Record<string, any> {
  const key = Object.keys(node).find((name) => name.startsWith("__reactProps$"));
  return key ? node[key] : {};
}

function descendants(node: any): any[] {
  return [node, ...Array.from(node.childNodes ?? []).flatMap(descendants)];
}

function textOf(node: any): string {
  if (node.nodeType === 3) return node.data ?? node.textContent ?? "";
  const children = Array.from(node.childNodes ?? []);
  return children.length ? children.map(textOf).join("") : (node.textContent ?? "");
}

const longOutput = `${"a long output line\n".repeat(200)}STDERR:\nTAIL error detail\nExit code: 1`;
let root: Root;
let container: HTMLElement;
let writes: string[];
let failClipboard: boolean;
const restore: Array<() => void> = [];

function replace(object: object, key: PropertyKey, value: unknown) {
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  Object.defineProperty(object, key, { configurable: true, writable: true, value });
  restore.push(() => {
    if (descriptor) Object.defineProperty(object, key, descriptor);
    else Reflect.deleteProperty(object, key);
  });
}

beforeEach(() => {
  ensureMiniDom();
  writes = [];
  failClipboard = false;
  replace(globalThis, "navigator", {
    clipboard: {
      writeText: async (text: string) => {
        if (failClipboard) throw new Error("Clipboard unavailable");
        writes.push(text);
      },
    },
  });
  replace(window, "isSecureContext", true);
  replace(document, "execCommand", () => false);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
    await flushMicrotasks();
  });
  document.body.removeChild(container);
  for (const reset of restore.splice(0).reverse()) reset();
});

async function render(element: React.ReactNode) {
  await act(async () => {
    root.render(<ToastProvider>{element}</ToastProvider>);
    await flushMicrotasks();
  });
}

async function click(node: any) {
  await act(async () => {
    await props(node).onClick({ stopPropagation() {} });
    await flushMicrotasks();
  });
}

function outputBlock(label: string) {
  return descendants(container).find((node) => props(node)["data-tool-output"] === label);
}

function controls(block: any) {
  const nodes = descendants(block);
  return {
    output: nodes.find((node) => node.tagName === "PRE"),
    copy: nodes.find((node) => node.tagName === "BUTTON" && props(node)["aria-label"]),
    toggle: nodes.find((node) => node.tagName === "BUTTON" && props(node)["aria-controls"]),
  };
}

describe("ToolOutputBlock", () => {
  test.each([
    ["many lines", longOutput],
    ["one long line", `${"x".repeat(50_000)}TAIL`],
  ])("bounds %s while keeping the full tail reachable and copyable", async (_case, value) => {
    await render(<ToolOutputBlock label="result" text={value} />);
    let ui = controls(outputBlock("result"));
    expect(textOf(ui.output)).not.toContain("TAIL");
    expect(textOf(ui.output).length).toBeLessThan(2_001);
    expect(props(ui.toggle).type).toBe("button");
    expect(props(ui.toggle)["aria-expanded"]).toBe(false);
    expect(props(ui.toggle)["aria-controls"]).toBe(props(ui.output).id);
    expect(props(ui.output).tabIndex).toBe(0);

    await click(ui.copy);
    expect(writes).toEqual([value]);
    await click(ui.toggle);
    ui = controls(outputBlock("result"));
    expect(textOf(ui.output)).toBe(value);
    expect(props(ui.output).className).toContain("max-h-64");
    expect(props(ui.output).className).toContain("overflow-auto");
    expect(props(ui.toggle)["aria-expanded"]).toBe(true);
    await click(ui.toggle);
    expect(textOf(controls(outputBlock("result")).output)).not.toContain("TAIL");
  });

  test("handles empty output without an expansion control and copies the empty source", async () => {
    await render(<ToolOutputBlock label="content" text="" />);
    const ui = controls(outputBlock("content"));
    expect(ui.toggle).toBeUndefined();
    expect(textOf(ui.output).length).toBeGreaterThan(0);
    await click(ui.copy);
    expect(writes).toEqual([""]);
  });

  test("shows the copy failure instead of a success state", async () => {
    failClipboard = true;
    await render(<ToolOutputBlock label="result" text="result" />);
    await click(controls(outputBlock("result")).copy);
    expect(writes).toEqual([]);
    expect(textOf(container)).toContain("复制失败，请重试。");
    expect(props(controls(outputBlock("result")).copy)["aria-label"]).not.toContain("已复制");
  });

  test("does not split an emoji at the preview boundary", async () => {
    const value = `${"x".repeat(1_999)}😀TAIL`;
    await render(<ToolOutputBlock label="result" text={value} />);
    const ui = controls(outputBlock("result"));
    expect(textOf(ui.output)).toBe("x".repeat(1_999));
    await click(ui.toggle);
    expect(textOf(controls(outputBlock("result")).output)).toBe(value);
  });
});

describe("tool card output integration", () => {
  const message: ToolMessage = {
    kind: "tool",
    id: "tool-output-1",
    toolName: "TestTool",
    args: "{}",
    status: "succeeded",
    startedAt: 1,
    result: longOutput,
  };

  test.each([
    ["read", "content"],
    ["write", "content"],
    ["edit", "+ new"],
    ["generic", "result"],
    ["bash", "stdout"],
  ] as const)("%s details expose the complete result", async (kind, label) => {
    const card =
      kind === "generic" ? (
        <GenericToolCard message={message} />
      ) : kind === "bash" ? (
        <BashToolCard message={message} />
      ) : (
        <FileToolCard
          message={{
            ...message,
            args: JSON.stringify({
              content: longOutput,
              old_string: "old",
              new_string: longOutput,
            }),
          }}
          variant={kind}
        />
      );
    await render(card);
    await click(descendants(container).find((node) => node.tagName === "BUTTON"));
    const ui = controls(outputBlock(label));
    expect(textOf(ui.output)).not.toContain("TAIL");
    await click(ui.toggle);
    expect(textOf(controls(outputBlock(label)).output)).toBe(longOutput);
    await click(controls(outputBlock(label)).copy);
    expect(writes).toEqual([longOutput]);
    if (kind === "edit") {
      expect(props(controls(outputBlock("+ new")).output).className).toContain("text-status-ok");
      expect(props(controls(outputBlock("- old")).output).className).toContain("text-status-err");
    }
    if (kind === "bash") {
      expect(
        descendants(controls(outputBlock(label)).output).some(
          (node) => props(node).className === "text-status-err" && textOf(node).includes("TAIL"),
        ),
      ).toBe(true);
    }
  });
});
