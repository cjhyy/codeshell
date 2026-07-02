import { expect, test, describe } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import React from "react";
import { StreamingMarkdown } from "./StreamingMarkdown";

// Stage 0a: byte-identical to the previous inline `done ? <Markdown/> : <pre>`.
// No DOM here — assert the static HTML shape.

describe("StreamingMarkdown (stage 0a)", () => {
  test("empty text renders nothing", () => {
    expect(renderToStaticMarkup(<StreamingMarkdown text="" done={false} />)).toBe("");
    expect(renderToStaticMarkup(<StreamingMarkdown text="" done={true} />)).toBe("");
  });

  test("streaming renders plain <pre>, no markdown structure", () => {
    const html = renderToStaticMarkup(
      <StreamingMarkdown text={"# Heading\n- item"} done={false} />,
    );
    expect(html).toContain("<pre");
    expect(html).toContain("whitespace-pre-wrap");
    // Raw markdown source, not parsed structure.
    expect(html).toContain("# Heading");
    expect(html).not.toContain("<h1");
    expect(html).not.toContain("<ul");
  });

  test("done renders markdown structure via full pipeline", () => {
    const html = renderToStaticMarkup(
      <StreamingMarkdown text={"# Heading\n\n- item"} done={true} />,
    );
    expect(html).toContain("<h1");
    expect(html).toContain("<ul");
    expect(html).not.toContain("# Heading");
  });

  test("done highlights fenced code (full pipeline, hljs classes)", () => {
    const html = renderToStaticMarkup(
      <StreamingMarkdown text={"```js\nconst x = 1;\n```"} done={true} />,
    );
    expect(html).toContain("hljs");
  });

  test("streaming does NOT run highlight on code", () => {
    const html = renderToStaticMarkup(
      <StreamingMarkdown text={"```js\nconst x = 1;\n```"} done={false} />,
    );
    expect(html).not.toContain("hljs");
    expect(html).toContain("<pre");
  });
});
