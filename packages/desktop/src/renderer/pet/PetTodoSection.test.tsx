import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import PetTodoSectionView, { orderTodoItems } from "./PetTodoSection";
import type { PetSessionTodos } from "../../preload/types";

const groups: PetSessionTodos[] = [
  {
    sessionId: "session-a",
    title: "修复 Pet 工作台",
    workspace: "codeshell",
    updatedAt: 3_000,
    todos: [
      { id: "1", subject: "写 pending 项", activeForm: "写 pending 项", status: "pending" },
      { id: "2", subject: "跑测试", activeForm: "正在跑测试", status: "in_progress" },
      { id: "3", subject: "已完成项", activeForm: "已完成项", status: "completed" },
    ],
  },
  {
    sessionId: "session-b",
    title: "整理文档",
    updatedAt: 2_000,
    todos: [{ id: "1", subject: "更新 README", activeForm: "更新 README", status: "pending" }],
  },
];

describe("PetTodoSectionView", () => {
  test("renders session groups with a count badge of total open items", () => {
    const html = renderToStaticMarkup(<PetTodoSectionView groups={groups} loading={false} />);
    expect(html).toContain('data-pet-todos="cross-session"');
    expect(html).toContain("待办事项");
    expect(html).toContain("修复 Pet 工作台");
    expect(html).toContain("整理文档");
    expect(html).toContain("codeshell");
    // Count badge = total open items across groups (3 open, completed excluded from ordering).
    expect(html).toContain(">3<");
  });

  test("renders in_progress activeForm before pending subject", () => {
    const html = renderToStaticMarkup(<PetTodoSectionView groups={groups} loading={false} />);
    const runningIndex = html.indexOf("正在跑测试");
    const pendingIndex = html.indexOf("写 pending 项");
    expect(runningIndex).toBeGreaterThanOrEqual(0);
    expect(pendingIndex).toBeGreaterThanOrEqual(0);
    expect(runningIndex).toBeLessThan(pendingIndex);
  });

  test("shows the empty state when there are no groups", () => {
    const html = renderToStaticMarkup(<PetTodoSectionView groups={[]} loading={false} />);
    expect(html).toContain("没有未完成的待办");
    expect(html).toContain(">0<");
  });

  test("shows the loading state on first load", () => {
    const html = renderToStaticMarkup(<PetTodoSectionView groups={[]} loading />);
    expect(html).toContain("正在整理待办事项");
  });

  test("wires an open affordance only when onOpen is provided", () => {
    const withOpen = renderToStaticMarkup(
      <PetTodoSectionView groups={groups} loading={false} onOpen={() => {}} />,
    );
    expect(withOpen).toContain('data-pet-todo-open="session-a"');
    const withoutOpen = renderToStaticMarkup(
      <PetTodoSectionView groups={groups} loading={false} />,
    );
    expect(withoutOpen).not.toContain("data-pet-todo-open");
  });
});

describe("orderTodoItems", () => {
  test("puts in_progress before pending, preserving order within a status", () => {
    const ordered = orderTodoItems([
      { id: "1", subject: "p1", activeForm: "p1", status: "pending" },
      { id: "2", subject: "r1", activeForm: "r1", status: "in_progress" },
      { id: "3", subject: "p2", activeForm: "p2", status: "pending" },
      { id: "4", subject: "r2", activeForm: "r2", status: "in_progress" },
    ]);
    expect(ordered.map((todo) => todo.id)).toEqual(["2", "4", "1", "3"]);
  });
});
