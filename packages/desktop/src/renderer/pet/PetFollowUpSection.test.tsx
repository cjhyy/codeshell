import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { PetSessionSummaryRow } from "../../preload/types";
import PetFollowUpSectionView, { followUpDismissId } from "./PetFollowUpSection";

function row(overrides: Partial<PetSessionSummaryRow> = {}): PetSessionSummaryRow {
  return {
    sessionId: "s1",
    title: "修复登录流程",
    workspace: "codeshell",
    terminalAt: 1_000,
    text: "要不要我再补一版异常场景的单测？",
    ...overrides,
  };
}

describe("PetFollowUpSectionView", () => {
  test("renders each row's title, workspace, and full follow-up text", () => {
    const html = renderToStaticMarkup(
      <PetFollowUpSectionView
        rows={[
          row(),
          row({
            sessionId: "s2",
            title: "重构缓存",
            text: "记得后续确认失效策略是否覆盖 TTL 边界",
          }),
        ]}
        onOpen={() => {}}
        onDismiss={() => {}}
      />,
    );
    expect(html).toContain("需要跟进");
    expect(html).toContain("修复登录流程");
    expect(html).toContain("codeshell");
    // Full text, not truncated.
    expect(html).toContain("要不要我再补一版异常场景的单测？");
    expect(html).toContain("重构缓存");
    expect(html).toContain("记得后续确认失效策略是否覆盖 TTL 边界");
    // The follow-up paragraph wraps in full — no truncate class on the text node.
    expect(html).toContain("whitespace-pre-wrap");
  });

  test("provides an open affordance per row wired to the sessionId", () => {
    const html = renderToStaticMarkup(
      <PetFollowUpSectionView rows={[row()]} onOpen={() => {}} onDismiss={() => {}} />,
    );
    expect(html).toContain('data-pet-follow-up-open="s1"');
    expect(html).toContain('data-pet-follow-up-dismiss="s1"');
  });

  test("excludes rows whose dismiss id is in dismissedIds", () => {
    const html = renderToStaticMarkup(
      <PetFollowUpSectionView
        rows={[row(), row({ sessionId: "s2", title: "还留着的" })]}
        dismissedIds={new Set([followUpDismissId("s1")])}
        onOpen={() => {}}
        onDismiss={() => {}}
      />,
    );
    expect(html).not.toContain("修复登录流程");
    expect(html).toContain("还留着的");
  });

  test("renders nothing when there are no rows", () => {
    expect(renderToStaticMarkup(<PetFollowUpSectionView rows={[]} />)).toBe("");
  });

  test("renders nothing when every row is dismissed", () => {
    const html = renderToStaticMarkup(
      <PetFollowUpSectionView rows={[row()]} dismissedIds={new Set([followUpDismissId("s1")])} />,
    );
    expect(html).toBe("");
  });

  test("followUpDismissId shares the completed work-inbox namespace", () => {
    expect(followUpDismissId("abc")).toBe("completed:abc");
  });
});
