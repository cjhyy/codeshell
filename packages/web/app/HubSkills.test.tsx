import { afterEach, beforeEach, expect, test } from "bun:test";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ensureMiniDom, flushMicrotasks } from "../src/test-utils/renderHook.js";
import { HubSkills } from "./HubSkills.js";

// The minimal DOM has no event bubbling; invoke the rendered React handlers.
function nodes(node: unknown): any[] {
  const current = node as { childNodes?: unknown[] };
  return [node, ...Array.from(current.childNodes ?? []).flatMap(nodes)];
}
function props(node: unknown): Record<string, any> {
  const current = node as Record<string, any>;
  const key = Object.keys(current).find((name) => name.startsWith("__reactProps$"));
  return key ? current[key] : {};
}
function textOf(node: any): string {
  if (node.nodeType === 3) return node.nodeValue ?? node.textContent ?? "";
  const children = Array.from(node.childNodes ?? []);
  return children.length ? children.map(textOf).join("") : (node.textContent ?? "");
}

let root: Root | null = null;
let container: HTMLElement;
let savedFetch: typeof fetch;
let current = { revision: "r1", content: "---\nname: demo\n---\nv1\n" };
const puts: Array<{ revision: string; content: string }> = [];

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  ensureMiniDom();
  savedFetch = globalThis.fetch;
  current = { revision: "r1", content: "---\nname: demo\n---\nv1\n" };
  puts.length = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/api/v1/skills/detail")) {
      return json(200, { name: "demo", editable: true, ...current });
    }
    if (url.includes("/api/v1/skills/local") && init?.method === "PUT") {
      const body = JSON.parse(String(init.body));
      puts.push({ revision: body.revision, content: body.content });
      if (body.revision !== current.revision) {
        return json(409, { error: "Skill 已发生变化，请刷新后重试。" });
      }
      current = { revision: `${current.revision}+`, content: body.content };
      return json(200, { ok: true, message: "已保存", name: "demo" });
    }
    if (url.includes("/api/v1/skills")) {
      return json(200, {
        directories: [],
        skills: [
          {
            name: "demo",
            description: "demo skill",
            source: "project",
            enabled: true,
            editable: true,
            removable: true,
            revision: current.revision,
          },
        ],
      });
    }
    return json(404, { error: "unexpected" });
  }) as typeof fetch;
  container = document.createElement("div");
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => {
    root?.unmount();
    await flushMicrotasks();
  });
  root = null;
  globalThis.fetch = savedFetch;
});

async function settle(): Promise<void> {
  for (let index = 0; index < 5; index += 1) {
    await act(async () => {
      await flushMicrotasks();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}
function button(label: string): any {
  const found = nodes(container).find(
    (node) => node.tagName === "BUTTON" && textOf(node).trim() === label,
  );
  if (!found) throw new Error(`Missing button ${label} in ${textOf(container)}`);
  return found;
}
async function click(label: string): Promise<void> {
  const target = button(label);
  expect(props(target).disabled).not.toBe(true);
  await act(async () => {
    props(target).onClick?.({ currentTarget: target, preventDefault() {} });
  });
  await settle();
}
function editor(): any {
  return nodes(container).find(
    (node) => node.tagName === "TEXTAREA" && props(node)["aria-label"] === "SKILL.md 内容",
  );
}
async function submitEditor(): Promise<void> {
  const form = nodes(container).find((node) => node.tagName === "FORM");
  await act(async () => {
    props(form).onSubmit({ preventDefault() {} });
  });
  await settle();
}

test("after a save conflict the editor can adopt the latest revision without losing the draft", async () => {
  await act(async () => {
    root?.render(<HubSkills onAuthLost={() => {}} />);
  });
  await settle();
  await click("查看与编辑");
  const draft = "---\nname: demo\n---\nmy draft\n";
  await act(async () => {
    props(editor()).onChange({ target: { value: draft } });
  });

  // Another device saves first.
  current = { revision: "r2", content: "---\nname: demo\n---\nother device\n" };
  await submitEditor();
  expect(puts.at(-1)).toEqual({ revision: "r1", content: draft });
  expect(props(editor()).value).toBe(draft);

  await click("读取最新版本");
  const latest = nodes(container).find(
    (node) => node.tagName === "TEXTAREA" && props(node)["aria-label"] === "最新版本内容",
  );
  expect(props(latest).value).toBe(current.content);
  expect(props(latest).readOnly).toBe(true);
  expect(puts).toHaveLength(1);

  await click("基于最新版本保存我的草稿");
  expect(props(editor()).value).toBe(draft);
  await submitEditor();

  expect(puts.at(-1)).toEqual({ revision: "r2", content: draft });
  expect(current.content).toBe(draft);
});
