import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Markdown } from "./Markdown";

describe("Markdown", () => {
  test("renders a path reference as plain text until existence is confirmed", () => {
    // Path links are now existence-gated: PathLink renders plain text and only
    // upgrades to a clickable <a class="md-file-link"> after an async
    // fs:exists check resolves true. renderToStaticMarkup runs no effects /
    // IPC, so the initial render is plain text — never a dead link.
    const html = renderToStaticMarkup(
      <Markdown text="- [Foo.tsx](/Users/me/app/src/Foo.tsx:81): updated" />,
    );

    expect(html).toContain("Foo.tsx");
    expect(html).not.toContain('data-path-link="true"');
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

  test("keeps external links as normal links; path text renders inline", () => {
    const html = renderToStaticMarkup(
      <Markdown text="外部 [site](https://example.com) 内部 packages/core/src/index.ts" />,
    );

    // External link stays a normal anchor.
    expect(html).toContain('href="https://example.com"');
    // The internal path renders as text (clickability is existence-gated and
    // resolved async — not present in a static render).
    expect(html).toContain("packages/core/src/index.ts");
    expect(html).not.toContain('data-path-link="true"');
  });

  test("long code blocks collapse with an expand toggle (TODO 2.6)", () => {
    const code = Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n");
    const html = renderToStaticMarkup(<Markdown text={"```ts\n" + code + "\n```"} />);
    expect(html).toContain("md-code-collapsed");
    expect(html).toContain("md-code-expand");
    expect(html).toContain("展开全部 (40 行)");
  });

  test("short code blocks are not collapsed", () => {
    const html = renderToStaticMarkup(<Markdown text={"```ts\nconst a = 1;\n```"} />);
    expect(html).not.toContain("md-code-collapsed");
    expect(html).not.toContain("md-code-expand");
  });
});
