import { afterEach, describe, expect, test } from "bun:test";
import React, { act } from "react";
import type { Root } from "react-dom/client";
import { ensureMiniDom, flushMicrotasks } from "../../test-utils/renderHook";
import type { PetJournalEntry, PetMemoryEntry } from "../../../preload/types";

ensureMiniDom();
const { createRoot } = await import("react-dom/client");
const { MemorySection } = await import("./MemorySection");

function reactPropsOf(node: unknown): Record<string, any> {
  const current = node as Record<string, any>;
  const key = Object.keys(current).find((name) => name.startsWith("__reactProps$"));
  return key ? current[key] : {};
}

function find(node: any, attribute: string, value?: string): any[] {
  const own = node.getAttribute?.(attribute);
  return [
    ...(own !== null && own !== undefined && (value === undefined || own === value) ? [node] : []),
    ...(node.childNodes ?? []).flatMap((child: any) => find(child, attribute, value)),
  ];
}

function textOf(node: any): string {
  if (node.nodeType === 3) return node.nodeValue ?? "";
  return (node.textContent ?? "") + (node.childNodes ?? []).map(textOf).join("");
}

const memory = (id: string, source: PetMemoryEntry["source"]) =>
  ({ id, text: id, source }) as PetMemoryEntry;

describe("Mimi settings › 记忆", () => {
  let root: Root | null = null;
  afterEach(async () => {
    await act(async () => root?.unmount());
    root = null;
  });

  async function mount(api: Record<string, unknown>, opens: string[]) {
    const container = document.createElement("div");
    root = createRoot(container);
    await act(async () => {
      root!.render(
        <MemorySection api={api as never} onOpenMemoryCenter={() => opens.push("center")} />,
      );
      for (let index = 0; index < 4; index += 1) await flushMicrotasks();
    });
    return container;
  }

  test("summarizes what Mimi holds and keeps the counts live", async () => {
    let onMemories: (entries: PetMemoryEntry[]) => void = () => undefined;
    const opens: string[] = [];
    const container = await mount(
      {
        listMemories: async () => [memory("a", "user"), memory("b", "auto"), memory("c", "auto")],
        listJournal: async () => [{ id: "j1" } as PetJournalEntry],
        getMemoryAutoExtract: async () => true,
        setMemoryAutoExtract: async (value: boolean) => value,
        onMemoriesChanged: (listener: typeof onMemories) => {
          onMemories = listener;
          return () => undefined;
        },
      },
      opens,
    );
    const count = (key: string) => textOf(find(container, "data-pet-memory-count", key)[0]);
    expect(count("memories")).toContain("3");
    expect(count("auto")).toContain("2");
    expect(count("journal")).toContain("1");
    await act(async () => onMemories([memory("a", "user")]));
    expect(count("memories")).toContain("1");
    expect(count("auto")).toContain("0");
    const [open] = find(container, "data-pet-open-memory-center");
    act(() => reactPropsOf(open).onClick());
    expect(opens).toEqual(["center"]);
  });

  test("the auto-extract switch rolls back and explains a failed save", async () => {
    const writes: boolean[] = [];
    const container = await mount(
      {
        listMemories: async () => [],
        listJournal: async () => [],
        getMemoryAutoExtract: async () => true,
        setMemoryAutoExtract: async (value: boolean) => {
          writes.push(value);
          throw new Error("settings locked");
        },
      },
      [],
    );
    const [card] = find(container, "data-pet-setting", "auto-extract");
    const [toggle] = find(card, "role", "switch");
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    await act(async () => {
      reactPropsOf(toggle).onClick({ defaultPrevented: false, preventDefault() {} });
      for (let index = 0; index < 4; index += 1) await flushMicrotasks();
    });
    expect(writes).toEqual([false]);
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    expect(textOf(container)).toContain("开关没有保存：settings locked");
  });
});
