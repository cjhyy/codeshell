import { describe, expect, test } from "bun:test";
import type { PetProjectionSnapshot } from "../../preload/types";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PetWorldPane } from "./PetWorldPane";

const reclaimed: PetProjectionSnapshot = {
  version: 1,
  generation: 0,
  workerState: "reclaimed",
  observedAt: 1_000,
  sessions: [],
  pending: [],
};

describe("PetWorldPane", () => {
  test("shows an empty work map without exposing a raw session list", () => {
    const html = renderToStaticMarkup(
      <PetWorldPane projection={reclaimed} status="ready" now={2_000} />,
    );

    expect(html).toContain("目前没有明确的未完成或可优化工作");
    expect(html).toContain("工作收件箱");
    expect(html).not.toContain("工作会话");
    expect(html).not.toContain("待你决定");
    expect(html).toContain('data-pet-world-pane="deterministic"');
  });

  test("keeps a dedicated loading state without occupying the chat pane", () => {
    const html = renderToStaticMarkup(
      <PetWorldPane projection={null} status="loading" now={2_000} />,
    );
    expect(html).toContain("正在加载工作状态");
    expect(html).toContain("正在整理工作收件箱");
  });

  test("reports snapshot failure as retrying instead of looking freshly updated", () => {
    const html = renderToStaticMarkup(
      <PetWorldPane projection={null} status="error" now={2_000} />,
    );
    expect(html).toContain("加载失败，正在重试");
    expect(html).toContain("暂时无法加载会话");
    expect(html).not.toContain("刚刚更新");
  });
});
