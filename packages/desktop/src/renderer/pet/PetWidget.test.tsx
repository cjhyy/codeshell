import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PetWidget } from "./PetWidget";

describe("PetWidget", () => {
  test("renders a personified bottom-left entry with condensed shared indicators", () => {
    const html = renderToStaticMarkup(
      <PetWidget visible runningCount={2} pendingCount={120} onOpen={() => undefined} />,
    );
    expect(html).toContain('data-pet-widget="bottom-left"');
    expect(html).toContain("99+");
    expect(html).toContain('data-pet-indicator="running"');
    expect(html).toContain("120 个 session 等你决定；2 个正在运行");
  });

  test("renders nothing when the persisted preference is off", () => {
    expect(
      renderToStaticMarkup(
        <PetWidget visible={false} runningCount={1} pendingCount={1} onOpen={() => undefined} />,
      ),
    ).toBe("");
  });
});
