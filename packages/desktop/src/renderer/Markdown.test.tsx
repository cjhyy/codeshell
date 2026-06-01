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
});
