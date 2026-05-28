import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { FilesChangedCard } from "./FilesChangedCard";
import type { FilesChangedSummaryMessage } from "../types";

function card(over: Partial<FilesChangedSummaryMessage> = {}): FilesChangedSummaryMessage {
  return {
    kind: "files_changed",
    id: "fc1",
    files: [{ path: "a.ts", added: 5, removed: 2, count: 1 }],
    totalAdded: 5,
    totalRemoved: 2,
    ...over,
  };
}

describe("FilesChangedCard", () => {
  test("renders folded summary header", () => {
    const html = renderToStaticMarkup(<FilesChangedCard message={card()} />);
    expect(html).toContain("已编辑 1 个文件");
    expect(html).toContain("+5");
    expect(html).toContain("-2");
    // Folded by default — body content (file paths) should NOT appear.
    expect(html).not.toContain("a.ts");
  });

  test("multi-file totals", () => {
    const m = card({
      files: [
        { path: "a.ts", added: 1, removed: 0, count: 1 },
        { path: "b.ts", added: 2, removed: 1, count: 1 },
        { path: "c.ts", added: 3, removed: 2, count: 1 },
      ],
      totalAdded: 6,
      totalRemoved: 3,
    });
    const html = renderToStaticMarkup(<FilesChangedCard message={m} />);
    expect(html).toContain("已编辑 3 个文件");
    expect(html).toContain("+6");
    expect(html).toContain("-3");
  });
});
