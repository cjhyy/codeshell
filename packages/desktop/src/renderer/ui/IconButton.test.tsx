import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { IconButton } from "./IconButton";

describe("IconButton", () => {
  test("renders explicit compact topbar button styling", () => {
    const html = renderToStaticMarkup(<IconButton label="折叠侧栏">x</IconButton>);

    expect(html).toContain("inline-flex h-7 w-7 items-center justify-center");
    expect(html).toContain("align-middle");
    expect(html).toContain("focus-visible:ring-ring/25");
  });
});
