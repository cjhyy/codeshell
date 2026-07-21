import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PetWidget } from "./PetWidget";

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
        onClose={() => undefined}
      />,
    );
    expect(html).toContain('data-pet-widget="desktop-window"');
    expect(html).toContain("h-28");
    expect(html).toContain("w-28");
    expect(html).toContain("absolute");
    expect(html).toContain("bg-transparent");
    expect(html).toContain("cs-pet-idle");
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
        onClose={() => undefined}
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
        onClose={() => undefined}
      />,
    );

    expect(html).toContain("收起 Session 动态");
    expect(html).toContain("展开 Mimi 聊天记录");
    expect(html).toContain("lucide-chevron-down");
    expect(html).not.toContain("99+");
  });
});
