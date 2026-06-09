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

  // Regression: a README's raw-HTML <img> with a relative src (the dog-icon
  // case) used to render nothing — react-markdown dropped raw HTML, and even
  // when parsed the relative path couldn't load via file://. rehype-raw now
  // parses the HTML, and the img handler routes a relative src through the
  // inline image loader (resolved against cwd, loaded as a data: URL).
  test("renders a README's raw-HTML <img> with a relative src via the inline loader", () => {
    const html = renderToStaticMarkup(
      <Markdown
        text={`<p align="center">\n  <img src="docs/images/codeshell-dog-icon.png" alt="dog" width="120" />\n</p>`}
        cwd="/repo"
      />,
    );
    // The raw HTML was parsed (rehype-raw) AND the relative image was routed to
    // InlineImageLink (md-inline-image), not left as a dead relative <img>.
    expect(html).toContain('class="md-inline-image"');
    expect(html).not.toContain('src="docs/images/codeshell-dog-icon.png"');
  });

  // SECURITY: the same renderer shows untrusted assistant/LLM output, so the
  // raw HTML that rehype-raw lets through MUST be sanitized. A <script> and an
  // onerror handler in the content must never survive into the DOM.
  test("strips <script> and event-handler attributes from raw HTML (XSS guard)", () => {
    const html = renderToStaticMarkup(
      <Markdown
        text={`hi <script>window.__pwned=1</script> <img src="https://x/y.png" onerror="alert(1)" /> bye`}
        cwd="/repo"
      />,
    );
    expect(html).not.toContain("<script");
    expect(html).not.toContain("window.__pwned");
    expect(html).not.toContain("onerror");
    expect(html).not.toContain("alert(1)");
  });

  test("strips <iframe> from raw HTML (XSS guard)", () => {
    const html = renderToStaticMarkup(
      <Markdown text={`<iframe src="https://evil.example"></iframe>`} cwd="/repo" />,
    );
    expect(html).not.toContain("<iframe");
  });

  test("leaves an absolute http(s) <img> src as a plain image", () => {
    const html = renderToStaticMarkup(
      <Markdown text={`<img src="https://example.com/logo.png" alt="logo" />`} cwd="/repo" />,
    );
    // Remote images are already loadable — not routed through the local loader.
    expect(html).toContain('src="https://example.com/logo.png"');
    expect(html).not.toContain('class="md-inline-image"');
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
