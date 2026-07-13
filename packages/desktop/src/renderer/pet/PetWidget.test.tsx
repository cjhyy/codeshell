import { describe, expect, test } from "bun:test";
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
        onOpen={() => undefined}
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
    expect(html).toContain('data-pet-indicator="activity"');
    expect(html).toContain("120 项工作提醒；其中 3 项完成未读；2 项执行中");
  });

  test("leaves desktop placement to the independent Electron window", () => {
    const html = renderToStaticMarkup(
      <PetWidget
        runningCount={0}
        activityCount={0}
        unreadCompletedCount={0}
        onOpen={() => undefined}
        onClose={() => undefined}
      />,
    );
    expect(html).not.toContain("position:fixed");
    expect(html).not.toContain("left:");
    expect(html).not.toContain("top:");
  });
});
