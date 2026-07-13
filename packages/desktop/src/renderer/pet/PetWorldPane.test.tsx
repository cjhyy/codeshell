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
  test("answers no-live-work deterministically while keeping pending before sessions", () => {
    const html = renderToStaticMarkup(
      <PetWorldPane projection={reclaimed} status="ready" now={2_000} />,
    );

    expect(html).toContain("没有实时工作，worker 已回收");
    expect(html).toContain("没有待处理决策");
    expect(html.indexOf("待你决定")).toBeLessThan(html.indexOf("工作会话"));
    expect(html).toContain('data-pet-world-pane="deterministic"');
  });

  test("keeps a dedicated loading state without occupying the chat pane", () => {
    const html = renderToStaticMarkup(
      <PetWorldPane projection={null} status="loading" now={2_000} />,
    );
    expect(html).toContain("正在加载工作状态");
    expect(html).toContain("正在加载会话");
  });
});
