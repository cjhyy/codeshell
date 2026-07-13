import { describe, expect, test } from "bun:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { ensureMiniDom, flushMicrotasks } from "../test-utils/renderHook";
import { PetOverviewHeader } from "./PetOverviewHeader";

function reactPropsOf(node: unknown): Record<string, any> {
  const current = node as Record<string, any>;
  const key = Object.keys(current).find((name) => name.startsWith("__reactProps$"));
  return key ? current[key] : {};
}

function findElement(node: unknown, tagName: string): any {
  const current = node as { tagName?: string; childNodes?: unknown[] };
  if (current.tagName === tagName) return current;
  for (const child of current.childNodes ?? []) {
    const found = findElement(child, tagName);
    if (found) return found;
  }
  return undefined;
}

function textOf(node: unknown): string {
  const current = node as { data?: string; textContent?: string; childNodes?: unknown[] };
  if (current.data !== undefined) return current.data;
  const children = (current.childNodes ?? []).map(textOf).join("");
  return children || current.textContent || "";
}

describe("PetOverviewHeader", () => {
  test("hides counts and freshness behind the Mimi workspace summary by default", () => {
    const html = renderToStaticMarkup(
      <PetOverviewHeader
        unfinishedCount={2}
        optimizationCount={1}
        completedCount={3}
        observedAt={1_000}
        now={61_000}
      />,
    );
    expect(html).toContain("Mimi 工作台");
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain('data-pet-overview-stat="unfinished"');
    expect(html).not.toContain('data-pet-overview-stat="optimization"');
    expect(html).not.toContain('data-pet-overview-stat="completed"');
    expect(html).not.toContain("1 分钟前更新");
  });

  test("reveals deterministic counts and freshness when clicked", async () => {
    ensureMiniDom();
    const container = document.createElement("div") as unknown as HTMLElement;
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <PetOverviewHeader
          unfinishedCount={2}
          optimizationCount={1}
          completedCount={3}
          observedAt={1_000}
          now={61_000}
        />,
      );
      await flushMicrotasks();
    });
    const button = findElement(container, "BUTTON");
    await act(async () => {
      reactPropsOf(button).onClick();
      await flushMicrotasks();
    });

    expect(reactPropsOf(button)["aria-expanded"]).toBe(true);
    expect(textOf(container)).toContain("未完成2");
    expect(textOf(container)).toContain("可优化1");
    expect(textOf(container)).toContain("最近完成3");
    expect(textOf(container)).toContain("1 分钟前更新");
    await act(async () => root.unmount());
  });

  test("distinguishes loading and reconciling without hiding a chat failure", () => {
    expect(renderToStaticMarkup(<PetOverviewHeader loading />)).toContain("正在加载工作状态");
    const html = renderToStaticMarkup(
      <PetOverviewHeader
        unfinishedCount={0}
        optimizationCount={0}
        completedCount={0}
        observedAt={1_000}
        now={2_000}
        reconciling
        chatError="Mimi 对话暂时不可用"
      />,
    );
    expect(html).toContain("正在对账");
    expect(html).toContain("Mimi 对话暂时不可用");
    expect(html).toContain("工作状态仍可查看");
  });
});
