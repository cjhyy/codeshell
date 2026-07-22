import { afterEach, describe, expect, test } from "bun:test";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { PetMemoryEntry } from "../../preload/types";
import { ensureMiniDom, flushMicrotasks } from "../test-utils/renderHook";
import { PetMemorySectionContent } from "./PetMemorySection";

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

function textOf(node: unknown): string {
  const current = node as {
    nodeType?: number;
    data?: string;
    childNodes?: unknown[];
    textContent?: string;
  };
  if (current.nodeType === 3) return current.data ?? current.textContent ?? "";
  const children = Array.from(current.childNodes ?? []);
  if (children.length === 0) return current.textContent ?? "";
  return children.map((child) => textOf(child)).join("");
}

let root: Root | null = null;
let originalCodeshell: unknown;

afterEach(async () => {
  if (root) {
    await act(async () => {
      root?.unmount();
      await flushMicrotasks();
    });
  }
  root = null;
  const testWindow = window as unknown as Record<string, unknown>;
  if (originalCodeshell === undefined) delete testWindow.codeshell;
  else testWindow.codeshell = originalCodeshell;
});

describe("PetMemorySection", () => {
  test("shows source and sends edits and confirmed deletes through the Pet API", async () => {
    ensureMiniDom();
    const testWindow = window as unknown as Record<string, any>;
    originalCodeshell = testWindow.codeshell;
    const entries: PetMemoryEntry[] = [
      {
        id: "mem-mimi",
        text: "用户偏好暗色主题",
        source: "mimi",
        createdAt: 1,
        updatedAt: 2,
      },
      {
        id: "mem-user",
        text: "默认使用 Bun",
        source: "user",
        createdAt: 3,
        updatedAt: 4,
      },
    ];
    const updateCalls: Array<[string, string]> = [];
    const removeCalls: string[] = [];
    testWindow.codeshell = {
      pet: {
        listMemories: async () => entries,
        updateMemory: async (id: string, text: string) => {
          updateCalls.push([id, text]);
          return { ...entries[0]!, id, text };
        },
        removeMemory: async (id: string) => {
          removeCalls.push(id);
          return entries.find((entry) => entry.id === id)!;
        },
      },
    };

    const container = document.createElement("div") as unknown as HTMLElement;
    root = createRoot(container);
    await act(async () => {
      root?.render(<PetMemorySectionContent confirmRemoval={async () => true} />);
      await flushMicrotasks();
      await flushMicrotasks();
    });

    const sectionToggle = findElements(container, "BUTTON").find(
      (button) => reactPropsOf(button)["aria-expanded"] === false,
    );
    await act(async () => {
      reactPropsOf(sectionToggle).onClick();
      await flushMicrotasks();
    });
    expect(textOf(container)).toContain("Mimi 记录");
    expect(textOf(container)).toContain("手动添加");

    const editButton = findElements(container, "BUTTON").find(
      (button) => reactPropsOf(button)["aria-label"] === "编辑",
    );
    await act(async () => {
      reactPropsOf(editButton).onClick();
      await flushMicrotasks();
    });
    const editArea = findElements(container, "TEXTAREA").find(
      (textarea) => reactPropsOf(textarea).value === "用户偏好暗色主题",
    );
    await act(async () => {
      reactPropsOf(editArea).onChange({ target: { value: "用户偏好深色主题" } });
      await flushMicrotasks();
    });
    const saveButton = findElements(container, "BUTTON").find(
      (button) => reactPropsOf(button)["aria-label"] === "保存",
    );
    await act(async () => {
      reactPropsOf(saveButton).onClick();
      await flushMicrotasks();
      await flushMicrotasks();
    });
    expect(updateCalls).toEqual([["mem-mimi", "用户偏好深色主题"]]);

    const deleteButton = findElements(container, "BUTTON").find(
      (button) => reactPropsOf(button)["aria-label"] === "删除",
    );
    await act(async () => {
      reactPropsOf(deleteButton).onClick();
      await flushMicrotasks();
      await flushMicrotasks();
    });
    expect(removeCalls).toEqual(["mem-mimi"]);
  });
});
