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
    expect(html).toContain("@min-[1100px]/pet-page:overflow-hidden");
  });

  test("shrinks the chat row before the single-column page needs to scroll", () => {
    const html = renderToStaticMarkup(
      <PetPage>
        <div>work pane</div>
        <div>chat pane</div>
      </PetPage>,
    );

    expect(html).toContain("h-full min-w-0 flex-1 flex-col overflow-hidden");
    expect(html).toContain("grid-rows-[auto_minmax(360px,1fr)]");
    expect(html).toContain("@min-[1100px]/pet-page:grid-rows-1");
    expect(html).toContain("@min-[1100px]/pet-page:overflow-hidden");
  });
});
