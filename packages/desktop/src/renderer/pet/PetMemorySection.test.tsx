import { afterEach, describe, expect, test } from "bun:test";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { PetMemoryEntry } from "../../preload/types";
import { ensureMiniDom, flushMicrotasks } from "../test-utils/renderHook";
import { PetMemorySection } from "./PetMemorySection";

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
  test("previews recent entries with source labels and links to the memory center", async () => {
    ensureMiniDom();
    const testWindow = window as unknown as Record<string, any>;
    originalCodeshell = testWindow.codeshell;
    const entries: PetMemoryEntry[] = [
      { id: "mem-auto", text: "偏好使用 Bun 构建", source: "auto", createdAt: 5, updatedAt: 6 },
      { id: "mem-mimi", text: "用户偏好暗色主题", source: "mimi", createdAt: 1, updatedAt: 2 },
      { id: "mem-user", text: "默认工作目录 ~/work", source: "user", createdAt: 3, updatedAt: 4 },
    ];
    testWindow.codeshell = { pet: { listMemories: async () => entries } };
    let managed = 0;

    const container = document.createElement("div") as unknown as HTMLElement;
    root = createRoot(container);
    await act(async () => {
      root?.render(<PetMemorySection onManage={() => (managed += 1)} />);
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

    const text = textOf(container);
    expect(text).toContain("自动提取");
    expect(text).toContain("Mimi 记录");
    expect(text).toContain("手动添加");
    // Read-only preview: no editable textarea, and no add/edit/delete controls.
    expect(findElements(container, "TEXTAREA")).toHaveLength(0);

    const manageButton = findElements(container, "BUTTON").find((button) =>
      textOf(button).includes("管理记忆"),
    );
    await act(async () => {
      reactPropsOf(manageButton).onClick();
      await flushMicrotasks();
    });
    expect(managed).toBe(1);
  });
});
