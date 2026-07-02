import { expect, test, describe } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import React from "react";
import { StreamingMarkdown } from "./StreamingMarkdown";

// No DOM here (renderToStaticMarkup) — effects/throttle timers don't run, so
// the throttled prefix equals the initial text on first render. Assert the
// static HTML shape.

describe("StreamingMarkdown — empty / done", () => {
  test("empty text renders nothing", () => {
    expect(renderToStaticMarkup(<StreamingMarkdown text="" done={false} />)).toBe("");
    expect(renderToStaticMarkup(<StreamingMarkdown text="" done={true} />)).toBe("");
  });

  test("done renders full markdown pipeline (structure + highlight)", () => {
    const html = renderToStaticMarkup(
      <StreamingMarkdown text={"# Heading\n\n```js\nconst x=1;\n```"} done={true} />,
    );
    expect(html).toContain("<h1");
    expect(html).toContain("hljs");
  });
});

describe("StreamingMarkdown — streaming rich render (stage 2)", () => {
  test("stable prefix (blank-line-closed) renders as markdown structure", () => {
    const html = renderToStaticMarkup(
      <StreamingMarkdown text={"# Title\n\nstill typing the tail"} done={false} />,
    );
    // "# Title" is a closed block (blank line after) → rendered as <h1>.
    expect(html).toContain("<h1");
    // The tail is plain source inside a <pre>.
    expect(html).toContain("<pre");
    expect(html).toContain("still typing the tail");
  });

  test("unclosed code fence stays as source (no hljs), not half-highlighted", () => {
    const html = renderToStaticMarkup(
      <StreamingMarkdown text={"Intro.\n\n```js\nconst x = 1;"} done={false} />,
    );
    expect(html).not.toContain("hljs");
    expect(html).toContain("```js");
    expect(html).toContain("const x = 1;");
    // The closed intro paragraph is rich.
    expect(html).toContain("Intro.");
  });

  test("raw HTML in stream is escaped, never parsed (narrow pipeline, no rehypeRaw)", () => {
    const html = renderToStaticMarkup(
      <StreamingMarkdown text={"<script>alert(1)</script>\n\ntail"} done={false} />,
    );
    // No executable script element leaks through.
    expect(html).not.toContain("<script>alert");
  });

  test("javascript: link is neutralized by default urlTransform (N1)", () => {
    const html = renderToStaticMarkup(
      <StreamingMarkdown text={"[click](javascript:alert(1))\n\ntail"} done={false} />,
    );
    expect(html).not.toContain("javascript:alert");
  });

  test("single unfinished paragraph → all source (no premature commit)", () => {
    const html = renderToStaticMarkup(
      <StreamingMarkdown text={"a heading maybe"} done={false} />,
    );
    // No blank line yet → nothing stable → shown as source.
    expect(html).toContain("<pre");
    expect(html).toContain("a heading maybe");
    expect(html).not.toContain("<h1");
  });
});

describe("StreamingMarkdown — feature-flag fallback", () => {
  test("streamingRichRender=false → today's plain <pre>", () => {
    const html = renderToStaticMarkup(
      <StreamingMarkdown text={"# Title\n\ntail"} done={false} streamingRichRender={false} />,
    );
    expect(html).toContain("<pre");
    expect(html).toContain("# Title");
    expect(html).not.toContain("<h1");
  });
});
