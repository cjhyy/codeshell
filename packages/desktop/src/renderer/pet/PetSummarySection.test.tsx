import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import PetSummarySectionView, { summaryDismissId } from "./PetSummarySection";
import type { PetSessionSummaryRow } from "../../preload/types";

const rows: PetSessionSummaryRow[] = [
  {
    sessionId: "session-a",
    title: "修复 Pet 工作台",
    workspace: "codeshell",
    terminalAt: 3_000,
    text: "已修复缓存问题；要不要我再补几个单测？",
  },
  {
    sessionId: "session-b",
    title: "整理文档",
    terminalAt: 2_000,
    text: "文档已更新完毕。",
  },
];

describe("PetSummarySectionView", () => {
  test("renders each row's title, workspace, and paragraph, with a count badge", () => {
    const html = renderToStaticMarkup(<PetSummarySectionView rows={rows} loading={false} />);
    expect(html).toContain('data-pet-summaries="closure"');
    expect(html).toContain("Mimi 小结");
    expect(html).toContain("修复 Pet 工作台");
    expect(html).toContain("整理文档");
    expect(html).toContain("codeshell");
    expect(html).toContain("已修复缓存问题；要不要我再补几个单测？");
    expect(html).toContain("文档已更新完毕。");
    expect(html).toContain(">2<");
  });

  test("renders rows in the given array order", () => {
    const html = renderToStaticMarkup(<PetSummarySectionView rows={rows} loading={false} />);
    const first = html.indexOf("修复 Pet 工作台");
    const second = html.indexOf("整理文档");
    expect(first).toBeGreaterThanOrEqual(0);
    expect(second).toBeGreaterThanOrEqual(0);
    expect(first).toBeLessThan(second);
  });

  test("excludes rows whose dismiss id is in dismissedIds and updates the badge", () => {
    const dismissedIds = new Set([summaryDismissId("session-a")]);
    const html = renderToStaticMarkup(
      <PetSummarySectionView rows={rows} loading={false} dismissedIds={dismissedIds} />,
    );
    expect(html).not.toContain("修复 Pet 工作台");
    expect(html).toContain("整理文档");
    expect(html).toContain(">1<");
  });

  test("shows the empty state when there are no rows", () => {
    const html = renderToStaticMarkup(<PetSummarySectionView rows={[]} loading={false} />);
    expect(html).toContain("暂无小结");
    expect(html).toContain(">0<");
  });

  test("shows the loading state on first load", () => {
    const html = renderToStaticMarkup(<PetSummarySectionView rows={[]} loading />);
    expect(html).toContain("正在整理小结");
  });

  test("wires open + dismiss affordances only when their handlers are provided", () => {
    const withHandlers = renderToStaticMarkup(
      <PetSummarySectionView rows={rows} loading={false} onOpen={() => {}} onDismiss={() => {}} />,
    );
    expect(withHandlers).toContain('data-pet-summary-open="session-a"');
    expect(withHandlers).toContain('data-pet-summary-dismiss="session-a"');
    const withoutHandlers = renderToStaticMarkup(
      <PetSummarySectionView rows={rows} loading={false} />,
    );
    expect(withoutHandlers).not.toContain("data-pet-summary-open");
    expect(withoutHandlers).not.toContain("data-pet-summary-dismiss");
  });
});

describe("summaryDismissId", () => {
  test("uses the completed: work-inbox prefix", () => {
    expect(summaryDismissId("abc")).toBe("completed:abc");
  });
});
