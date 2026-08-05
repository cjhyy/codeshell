import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { ensureMiniDom, flushMicrotasks } from "../test-utils/renderHook";
import { PetWidget } from "./PetWidget";

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

describe("PetWidget", () => {
  test("renders a frameless draggable pet with condensed shared indicators", () => {
    const html = renderToStaticMarkup(
      <PetWidget
        runningCount={2}
        activityCount={120}
        unreadCompletedCount={3}
        chatExpanded={false}
        activityExpanded={false}
        onToggleChat={() => undefined}
        onToggleActivity={() => undefined}
        onOpen={() => undefined}
        onContextMenu={() => undefined}
      />,
    );
    expect(html).toContain('data-pet-widget="desktop-window"');
    expect(html).toContain("h-28");
    expect(html).toContain("w-28");
    expect(html).toContain("absolute");
    expect(html).toContain("bg-transparent");
    // The default (builtin) pack renders one static image — the asset URL can
    // legitimately be replaced by another test's module fixture in a full run.
    expect(html).toContain("<img");
    expect(html).not.toContain("cs-pet-idle");
    expect(html).toContain("99+");
    expect(html).toContain('data-pet-indicator="running"');
    expect(html).toContain('data-pet-indicator="toggle"');
    expect(html).toContain('data-pet-action="chat"');
    expect(html).toContain('data-pet-action="activity"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain("展开 Mimi 聊天记录");
    expect(html).toContain("120 项工作提醒；其中 3 项完成未读；2 项执行中");

    const source = readFileSync(join(import.meta.dir, "PetWidget.tsx"), "utf8");
    expect(source).not.toContain('data-pet-indicator="activity"');
    expect(source).toContain('data-pet-action="activity"');
    expect(source).toContain("activityExpanded ? <ChevronDown");
    const activityButtonStart = source.indexOf('data-pet-indicator="toggle"');
    const activityButtonEnd = source.indexOf("onClick={onToggleActivity}", activityButtonStart);
    const activityButton = source.slice(activityButtonStart, activityButtonEnd);
    expect(activityButton).toContain("bg-transparent");
    expect(activityButton).not.toContain("border-border");
    expect(activityButton).not.toContain("bg-popover");
    expect(activityButton).not.toContain("shadow-md");
  });

  test("leaves desktop placement to the independent Electron window", () => {
    const html = renderToStaticMarkup(
      <PetWidget
        runningCount={0}
        activityCount={0}
        unreadCompletedCount={0}
        chatExpanded={true}
        activityExpanded={false}
        onToggleChat={() => undefined}
        onToggleActivity={() => undefined}
        onOpen={() => undefined}
        onContextMenu={() => undefined}
      />,
    );
    expect(html).not.toContain("position:fixed");
    expect(html).not.toContain("left:");
    expect(html).not.toContain("top:");
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain("收起 Mimi 聊天记录");
  });

  test("replaces the right-hand count with a collapse icon after activity opens", () => {
    const html = renderToStaticMarkup(
      <PetWidget
        runningCount={1}
        activityCount={120}
        unreadCompletedCount={0}
        chatExpanded={false}
        activityExpanded={true}
        onToggleChat={() => undefined}
        onToggleActivity={() => undefined}
        onOpen={() => undefined}
        onContextMenu={() => undefined}
      />,
    );

    expect(html).toContain("收起 Session 动态");
    expect(html).toContain("展开 Mimi 聊天记录");
    expect(html).toContain("lucide-chevron-down");
    expect(html).not.toContain("99+");
  });

  test("double-click opens Mimi and only right-click requests the close menu", async () => {
    ensureMiniDom();
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    let opened = 0;
    let contextMenus = 0;
    try {
      await act(async () => {
        root.render(
          <PetWidget
            runningCount={0}
            activityCount={0}
            unreadCompletedCount={0}
            chatExpanded={false}
            activityExpanded={false}
            onToggleChat={() => undefined}
            onToggleActivity={() => undefined}
            onOpen={() => {
              opened += 1;
            }}
            onContextMenu={() => {
              contextMenus += 1;
            }}
          />,
        );
        await flushMicrotasks();
      });
      const petButton = findElements(container, "BUTTON").find(
        (button) => reactPropsOf(button)["data-pet-action"] === "chat",
      );
      const event = { preventDefault() {} };
      await act(async () => {
        reactPropsOf(petButton).onDoubleClick(event);
        reactPropsOf(petButton).onContextMenu(event);
      });
      expect(opened).toBe(1);
      expect(contextMenus).toBe(1);
    } finally {
      await act(async () => root.unmount());
      document.body.removeChild(container);
    }
  });
});
