import { afterEach, describe, expect, test } from "bun:test";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { PetJournalEntry, PetMemoryEntry, PetSegmentMessage } from "../../preload/types";
import { ensureMiniDom, flushMicrotasks } from "../test-utils/renderHook";
import { JournalTab, MemoriesTab } from "./PetMemoryCenterPage";

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

describe("PetMemoryCenterPage", () => {
  test("durable-memory tab labels auto entries and adds a memory through the Pet API", async () => {
    ensureMiniDom();
    const testWindow = window as unknown as Record<string, any>;
    originalCodeshell = testWindow.codeshell;
    const added: string[] = [];
    testWindow.codeshell = {
      pet: {
        listMemories: async (): Promise<PetMemoryEntry[]> => [
          { id: "mem-auto", text: "偏好使用 Bun", source: "auto", createdAt: 1, updatedAt: 2 },
        ],
        addMemory: async (text: string) => {
          added.push(text);
          return { id: "mem-new", text, source: "user" as const, createdAt: 3, updatedAt: 3 };
        },
        getMemoryAutoExtract: async () => true,
        setMemoryAutoExtract: async (enabled: boolean) => enabled,
      },
    };

    const container = document.createElement("div") as unknown as HTMLElement;
    root = createRoot(container);
    await act(async () => {
      root?.render(<MemoriesTab confirmRemoval={async () => true} />);
      await flushMicrotasks();
      await flushMicrotasks();
    });

    expect(textOf(container)).toContain("自动提取");

    const draft = findElements(container, "TEXTAREA")[0];
    await act(async () => {
      reactPropsOf(draft).onChange({ target: { value: "新记忆" } });
      await flushMicrotasks();
    });
    const addButton = findElements(container, "BUTTON").find((button) =>
      textOf(button).includes("记住"),
    );
    await act(async () => {
      reactPropsOf(addButton).onClick();
      await flushMicrotasks();
      await flushMicrotasks();
    });
    expect(added).toEqual(["新记忆"]);
  });

  test("journal tab lazily loads a segment transcript only when expanded", async () => {
    ensureMiniDom();
    const testWindow = window as unknown as Record<string, any>;
    originalCodeshell = testWindow.codeshell;
    let transcriptCalls = 0;
    testWindow.codeshell = {
      pet: {
        listJournal: async (): Promise<PetJournalEntry[]> => [
          {
            id: "journal-1",
            segmentId: "seg-1",
            title: "调试构建",
            summary: "升级 Bun 后通过",
            startedAt: 1,
            endedAt: 2,
            messageCount: 4,
            range: { start: 0, end: 4 },
          },
        ],
        getSegmentMessages: async (): Promise<PetSegmentMessage[]> => {
          transcriptCalls += 1;
          return [
            { role: "user", text: "帮我调试" },
            { role: "assistant", text: "已修复" },
          ];
        },
      },
    };

    const container = document.createElement("div") as unknown as HTMLElement;
    root = createRoot(container);
    await act(async () => {
      root?.render(<JournalTab />);
      await flushMicrotasks();
      await flushMicrotasks();
    });

    expect(textOf(container)).toContain("调试构建");
    expect(transcriptCalls).toBe(0);

    const viewButton = findElements(container, "BUTTON").find((button) =>
      textOf(button).includes("查看原文"),
    );
    await act(async () => {
      reactPropsOf(viewButton).onClick();
      await flushMicrotasks();
      await flushMicrotasks();
    });
    expect(transcriptCalls).toBe(1);
    expect(textOf(container)).toContain("已修复");
  });
});
