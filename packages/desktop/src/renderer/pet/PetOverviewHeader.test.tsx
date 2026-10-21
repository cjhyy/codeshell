import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PetOverviewHeader } from "./PetOverviewHeader";

describe("PetOverviewHeader", () => {
  test("shows work counts and freshness without a disclosure", () => {
    const html = renderToStaticMarkup(
      <PetOverviewHeader
        runningCount={2}
        pendingCount={1}
        followUpCount={3}
        observedAt={1_000}
        now={61_000}
      />,
    );
    expect(html).toContain("Mimi 工作台");
    expect(html).toContain("工作动态");
    expect(html).toContain('data-pet-overview-stat="running"');
    expect(html).toContain('data-pet-overview-stat="pending"');
    expect(html).toContain('data-pet-overview-stat="follow-up"');
    expect(html).toContain("进行中");
    expect(html).toContain("待决策");
    expect(html).toContain("待跟进");
    expect(html).toContain("1 分钟前更新");
    expect(html).not.toContain("aria-expanded");
    expect(html).not.toContain("data-pet-overview-popover");
  });

  test("does not present absent snapshots as freshly updated or loading counts as zero", () => {
    const unknown = renderToStaticMarkup(<PetOverviewHeader />);
    expect(unknown).toContain("尚未同步");
    expect(unknown).not.toContain("刚刚更新");
    const loading = renderToStaticMarkup(<PetOverviewHeader loading />);
    expect(loading).toContain("正在加载工作状态");
    expect(loading).toContain("—");
    expect(loading).not.toContain("刚刚更新");
  });

  test("distinguishes loading, reconciling, and retrying while keeping a chat failure visible", () => {
    const html = renderToStaticMarkup(
      <PetOverviewHeader
        runningCount={0}
        pendingCount={0}
        followUpCount={0}
        observedAt={1_000}
        now={2_000}
        reconciling
        chatError="Mimi 对话暂时不可用"
      />,
    );
    expect(html).toContain("正在对账");
    expect(html).toContain("Mimi 对话暂时不可用");
    expect(html).toContain("工作状态仍可查看");
    expect(html).not.toContain("刚刚更新");
    const retrying = renderToStaticMarkup(<PetOverviewHeader retrying observedAt={1_000} />);
    expect(retrying).toContain("加载失败，正在重试");
    expect(retrying).not.toContain("分钟前更新");
  });
});

test("only exceptional states sit in the live region; the routine age does not", () => {
  const routine = renderToStaticMarkup(<PetOverviewHeader observedAt={1_000} now={61_000} />);
  expect(routine).toMatch(/<span role="status" aria-live="polite"><\/span>/);
  const retrying = renderToStaticMarkup(
    <PetOverviewHeader observedAt={1_000} now={61_000} retrying />,
  );
  expect(retrying).toMatch(/<span role="status" aria-live="polite">[^<]+<\/span>/);
});
