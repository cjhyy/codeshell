import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ToolMessage } from "../types";
import { BrowserToolCard, browserSummary } from "./BrowserToolCard";

function message(over: Partial<ToolMessage> = {}): ToolMessage {
  return {
    kind: "tool",
    id: "browser-1",
    toolName: "browser_observe",
    args: JSON.stringify({ mode: "vision" }),
    result: "[screenshot loaded]",
    status: "succeeded",
    startedAt: 0,
    ...over,
  };
}

describe("BrowserToolCard", () => {
  test("renders screenshot pixels inline even while the tool details are collapsed", () => {
    const html = renderToStaticMarkup(
      <BrowserToolCard
        message={message({
          images: [{ mediaType: "image/jpeg", data: "QUJD" }],
        })}
      />,
    );

    expect(html).toContain("data-browser-screenshot-preview");
    expect(html).toContain("data:image/jpeg;base64,QUJD");
    expect(html).toContain("页面截图");
    // Details are collapsed by default, so the result payload is intentionally
    // absent while the important visual preview remains in the timeline.
    expect(html).not.toContain("[screenshot loaded]");
  });

  test("does not render an empty preview for structural observations", () => {
    const html = renderToStaticMarkup(
      <BrowserToolCard
        message={message({
          args: JSON.stringify({ mode: "snapshot" }),
          result: "URL: https://example.com",
          images: undefined,
        })}
      />,
    );

    expect(html).not.toContain("data-browser-screenshot-preview");
    expect(html).toContain("已读取页面结构");
  });
});

describe("browserSummary", () => {
  test("uses concise browser-specific action and navigation summaries", () => {
    expect(
      browserSummary(
        { toolName: "browser_navigate", status: "succeeded" },
        { url: "https://example.com/products?q=1" },
      ),
    ).toBe("已打开 example.com/products");
    expect(
      browserSummary({ toolName: "browser_act", status: "succeeded" }, { action: "scroll" }),
    ).toBe("已滚动页面");
    expect(
      browserSummary({ toolName: "browser_observe", status: "succeeded" }, { mode: "vision" }),
    ).toBe("已截取页面画面");
  });
});
