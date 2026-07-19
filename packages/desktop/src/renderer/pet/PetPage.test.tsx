import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PetPage } from "./PetPage";

describe("PetPage", () => {
  test("is a standalone work surface without overlay controls", () => {
    const html = renderToStaticMarkup(
      <PetPage>
        <div>world pane</div>
        <div>chat slot</div>
      </PetPage>,
    );

    expect(html).toContain('data-pet-page="standalone"');
    expect(html).toContain('aria-label="Mimi 工作台页面"');
    expect(html).not.toContain('role="separator"');
    expect(html).not.toContain('aria-label="关闭 Mimi 概览"');
    expect(html).toContain("world pane");
    expect(html).toContain("chat slot");
    expect(html).toContain("@container/pet-page");
    expect(html).toContain(
      "@min-[1100px]/pet-page:grid-cols-[minmax(0,1fr)_minmax(320px,380px)]",
    );
  });
});
