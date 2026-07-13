import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PetOverviewHeader } from "./PetOverviewHeader";

describe("PetOverviewHeader", () => {
  test("renders deterministic counts and freshness", () => {
    const html = renderToStaticMarkup(
      <PetOverviewHeader
        runningCount={2}
        queuedCount={1}
        pendingCount={3}
        observedAt={1_000}
        now={61_000}
      />,
    );
    expect(html).toContain("2 个运行中");
    expect(html).toContain("1 个排队中");
    expect(html).toContain("3 个待决策");
    expect(html).toContain("1 分钟前更新");
  });

  test("distinguishes loading and reconciling without hiding a chat failure", () => {
    expect(renderToStaticMarkup(<PetOverviewHeader loading />)).toContain("正在加载工作状态");
    const html = renderToStaticMarkup(
      <PetOverviewHeader
        runningCount={0}
        queuedCount={0}
        pendingCount={0}
        observedAt={1_000}
        now={2_000}
        reconciling
        chatError="Pet chat 暂时不可用"
      />,
    );
    expect(html).toContain("正在对账");
    expect(html).toContain("Pet chat 暂时不可用");
    expect(html).toContain("工作状态仍可查看");
  });
});
