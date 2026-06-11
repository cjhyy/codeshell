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
    const html = renderToStaticMarkup(
      <FilesChangedCard message={card()} cwd={null} sessionId={null} isLatest />,
    );
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
    const html = renderToStaticMarkup(
      <FilesChangedCard message={m} cwd={null} sessionId={null} isLatest />,
    );
    expect(html).toContain("已编辑 3 个文件");
    expect(html).toContain("+6");
    expect(html).toContain("-3");
  });

  test("latest card with a session shows an undo button", () => {
    const html = renderToStaticMarkup(
      <FilesChangedCard message={card()} cwd={null} sessionId="s-1" isLatest />,
    );
    expect(html).toContain("撤销");
    expect(html).not.toContain("只能从最新一轮");
  });

  test("an older card's undo is disabled with an explanatory tooltip", () => {
    const html = renderToStaticMarkup(
      <FilesChangedCard message={card()} cwd={null} sessionId="s-1" isLatest={false} />,
    );
    expect(html).toContain("只能从最新一轮开始撤销");
    expect(html).toContain("disabled");
  });

  test("no session → no undo affordance (review/undo need session or repo)", () => {
    const html = renderToStaticMarkup(
      <FilesChangedCard message={card()} cwd={null} sessionId={null} isLatest />,
    );
    expect(html).not.toContain("撤销");
  });
});
