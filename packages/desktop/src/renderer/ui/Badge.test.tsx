import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Badge } from "./Badge";

describe("Badge", () => {
  test("uses semantic Tailwind colors and caps large counts", () => {
    const html = renderToStaticMarkup(<Badge count={120} tone="err" />);
    expect(html).toContain("bg-status-err");
    expect(html).toContain("99+");
    expect(html).not.toContain("badge-err");
  });

  test("does not render an empty badge", () => {
    expect(renderToStaticMarkup(<Badge count={0} />)).toBe("");
  });
});
