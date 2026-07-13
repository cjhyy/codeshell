import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PetSidebarEntry } from "./PetSidebarEntry";

describe("PetSidebarEntry", () => {
  test("renders independent pending and running indicators with a complete tooltip", () => {
    const html = renderToStaticMarkup(
      <PetSidebarEntry active pendingCount={120} runningCount={2} onOpen={() => undefined} />,
    );

    expect(html).toContain("Mimi");
    expect(html).toContain("99+");
    expect(html).toContain('data-pet-indicator="running"');
    expect(html).toContain('data-pet-indicator="pending"');
    expect(html).toContain("120 项等你处理；2 项执行中");
    expect(html).toContain('aria-pressed="true"');
  });

  test("hides zero-value indicators", () => {
    const html = renderToStaticMarkup(
      <PetSidebarEntry active={false} pendingCount={0} runningCount={0} onOpen={() => undefined} />,
    );

    expect(html).not.toContain('data-pet-indicator="running"');
    expect(html).not.toContain('data-pet-indicator="pending"');
    expect(html).toContain('aria-pressed="false"');
  });
});
