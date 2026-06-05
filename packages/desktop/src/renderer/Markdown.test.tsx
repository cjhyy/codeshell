import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Markdown } from "./Markdown";

describe("Markdown", () => {
  test("renders standard local path markdown links as clickable file links", () => {
    const html = renderToStaticMarkup(
      <Markdown text="- [Foo.tsx](/Users/me/app/src/Foo.tsx:81): updated" />,
    );

    expect(html).toContain('data-path-link="true"');
    expect(html).toContain('class="md-file-link"');
    expect(html).toContain("Foo.tsx");
    expect(html).toContain("/Users/me/app/src/Foo.tsx:81");
    expect(html).not.toContain('node="[object Object]"');
  });

  test("routes repo-relative markdown image syntax through the inline image loader", () => {
    const html = renderToStaticMarkup(
      <Markdown
        text="![framework overview](docs/architecture/images/00-framework-overview.png)"
        cwd="/repo"
      />,
    );

    expect(html).toContain('class="md-inline-image"');
    expect(html).not.toContain('src="docs/architecture/images/00-framework-overview.png"');
    expect(html).not.toContain("framework overview");
  });

  test("routes raw generated PNG paths through the inline image loader", () => {
    const html = renderToStaticMarkup(
      <Markdown text="生成完成：.code-shell/generated_images/example.png" cwd="/repo" />,
    );

    expect(html).toContain('class="md-inline-image"');
    expect(html).toContain("example.png");
    expect(html).not.toContain("codeshell-path:");
  });

  test("keeps external links as normal links while allowing internal path links", () => {
    const html = renderToStaticMarkup(
      <Markdown text="外部 [site](https://example.com) 内部 packages/core/src/index.ts" />,
    );

    expect(html).toContain('href="https://example.com"');
    expect(html).toContain("codeshell-path:");
    expect(html).toContain('data-path-link="true"');
  });
});
