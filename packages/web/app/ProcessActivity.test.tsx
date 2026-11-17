import { afterEach, beforeEach, expect, test } from "bun:test";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ensureMiniDom, flushMicrotasks } from "../src/test-utils/renderHook.js";
import { ProcessActivity } from "./ProcessActivity.js";
import type { ProcessActivityGroup, ProcessItem } from "./processActivityProjection.js";

function nodes(node: any): any[] {
  return [node, ...Array.from(node.childNodes ?? []).flatMap(nodes)];
}
function props(node: any): Record<string, any> {
  const key = Object.keys(node).find((name) => name.startsWith("__reactProps$"));
  return key ? node[key] : {};
}
function text(node: any): string {
  if (node.nodeType === 3) return node.nodeValue ?? node.textContent ?? "";
  const children = Array.from(node.childNodes ?? []);
  return children.length ? children.map(text).join("") : (node.textContent ?? "");
}
let root: Root;
let container: HTMLElement;
let reads: string[];
const tool = (id: string, done = true): ProcessItem => ({
  kind: "tool",
  id,
  name: id,
  done,
  detailRef: id,
});
const group = (items: ProcessItem[], running = false): ProcessActivityGroup => ({
  kind: "process",
  id: "process:one",
  items,
  running,
});

beforeEach(() => {
  ensureMiniDom();
  container = document.createElement("div");
  root = createRoot(container);
  reads = [];
});
afterEach(async () => {
  await act(async () => root.unmount());
});

async function render(value: ProcessActivityGroup) {
  await act(async () => {
    root.render(
      <ProcessActivity
        group={value}
        detailScope="owned-session"
        loadHistoryDetail={async (ref) => {
          reads.push(ref);
          return { result: `Result ${ref}` };
        }}
      />,
    );
    await flushMicrotasks();
  });
}
function heading() {
  return nodes(container).find((node) => props(node).className === "message-process-heading");
}
async function toggle() {
  await act(async () => {
    props(heading()).onClick();
    await flushMicrotasks();
  });
}
async function openDetails(className: string) {
  const node = nodes(container).find((node) => props(node).className === className);
  expect(node).toBeDefined();
  await act(async () => {
    props(node).onToggle({ currentTarget: { open: true } });
    await flushMicrotasks();
  });
}

test("live preview shows only active work and completion collapses without fetching history details", async () => {
  await render(group([tool("old-step"), tool("current-step", false)], true));
  expect(text(container)).toContain("current-step");
  expect(text(container)).not.toContain("old-step");
  expect(props(heading())["aria-expanded"]).toBe(false);
  await render(group([tool("old-step"), tool("current-step")]));
  expect(text(container)).toContain("处理完成");
  expect(text(container)).not.toContain("current-step");
  expect(
    nodes(container).filter((node) => props(node).className === "message-tool-card"),
  ).toHaveLength(0);
  expect(reads).toEqual([]);
});

test("manual expansion survives completion, refreshed objects and later items", async () => {
  await render(group([tool("first"), tool("second", false)], true));
  await toggle();
  expect(text(container)).toContain("first");
  await render(group([tool("first"), tool("second")]));
  await render(group([tool("first"), tool("second"), tool("third")]));
  expect(props(heading())["aria-expanded"]).toBe(true);
  expect(text(container)).toContain("first");
  expect(text(container)).toContain("third");
  await toggle();
  await render(group([tool("first"), tool("second"), tool("third")]));
  expect(props(heading())["aria-expanded"]).toBe(false);
  expect(text(container)).not.toContain("first");
});

test("historical process is collapsed and its narration has no reply-copy action when opened", async () => {
  await render(
    group([
      {
        kind: "assistant",
        id: "narration",
        text: "I checked the files.",
        reasoning: "",
        done: true,
      },
      tool("read"),
    ]),
  );
  expect(text(container)).not.toContain("I checked the files.");
  await toggle();
  expect(text(container)).toContain("I checked the files.");
  expect(text(container)).not.toContain("复制回复");
  expect(reads).toEqual([]);
});

test("manually opening current tool detail preserves the exact mounted detail after completion", async () => {
  await render(group([tool("older"), tool("current", false)], true));
  await openDetails("message-tool-card");
  expect(reads).toEqual(["current"]);
  expect(props(heading())["aria-expanded"]).toBe(true);
  expect(text(container)).toContain("Result current");
  await render(group([tool("older"), tool("current")]));
  expect(text(container)).toContain("Result current");
  expect(reads).toEqual(["current"]);
});

test("manually opening reasoning keeps it visible when the process completes", async () => {
  const thinking: ProcessItem = {
    kind: "assistant",
    id: "reasoning",
    text: "",
    reasoning: "Compare options",
    done: false,
  };
  await render(group([thinking], true));
  await openDetails("message-reasoning");
  expect(text(container)).toContain("Compare options");
  await render(group([{ ...thinking, done: true }]));
  expect(props(heading())["aria-expanded"]).toBe(true);
  expect(text(container)).toContain("Compare options");
});

test("idle unfinished tools stay visible and are not labelled as completed", async () => {
  await render(group([tool("old"), tool("needs-attention", false)]));
  expect(text(container)).toContain("处理未完成");
  expect(text(container)).toContain("needs-attention");
  expect(text(container)).not.toContain("处理完成");
  expect(text(container)).not.toContain("执行中");
  expect(reads).toEqual([]);
});

test("every parallel pending tool remains visible in the automatic preview", async () => {
  await render(
    group([tool("old"), tool("approval-pending", false), tool("other-active", false)], true),
  );
  expect(text(container)).toContain("approval-pending");
  expect(text(container)).toContain("other-active");
  expect(text(container)).not.toContain("old");
});
