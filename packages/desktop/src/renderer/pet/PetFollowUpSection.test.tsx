import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { PetSessionSummaryRow } from "../../preload/types";
import { petFollowUpStateId } from "../../shared/pet-work-item-id";
import PetFollowUpSectionView from "./PetFollowUpSection";

function row(overrides: Partial<PetSessionSummaryRow> = {}): PetSessionSummaryRow {
  return {
    followUpId: "followup-s1",
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
        onAskMimi={() => {}}
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
      <PetFollowUpSectionView
        rows={[row()]}
        onOpen={() => {}}
        onAskMimi={() => {}}
        onDismiss={() => {}}
      />,
    );
    expect(html).toContain('data-pet-follow-up-open="s1"');
    expect(html).toContain('data-pet-follow-up-ask-mimi="s1"');
    expect(html).toContain('data-pet-follow-up-complete="s1"');
    expect(html).toContain('data-pet-follow-up-dismiss="s1"');
    expect(html).toContain("继续处理");
    expect(html).toContain("交给 Mimi");
    expect(html).toContain("已处理");
  });

  test("excludes rows whose dismiss id is in dismissedIds", () => {
    const html = renderToStaticMarkup(
      <PetFollowUpSectionView
        rows={[row(), row({ followUpId: "followup-s2", sessionId: "s2", title: "还留着的" })]}
        dismissedIds={new Set([petFollowUpStateId("followup-s1")])}
        onOpen={() => {}}
        onDismiss={() => {}}
      />,
    );
    expect(html).not.toContain("修复登录流程");
    expect(html).toContain("还留着的");
  });

  test("keeps separate follow-up entities when one source session completes twice", () => {
    const html = renderToStaticMarkup(
      <PetFollowUpSectionView
        rows={[
          row({ followUpId: "followup-first", text: "第一次跟进" }),
          row({ followUpId: "followup-second", terminalAt: 2_000, text: "第二次跟进" }),
        ]}
      />,
    );
    expect(html).toContain('data-pet-follow-up-id="followup-first"');
    expect(html).toContain('data-pet-follow-up-id="followup-second"');
    expect(html).toContain("第一次跟进");
    expect(html).toContain("第二次跟进");
  });

  test("bounds the visible workbench list without letting hidden rows consume the limit", () => {
    const html = renderToStaticMarkup(
      <PetFollowUpSectionView
        rows={Array.from({ length: 22 }, (_, index) =>
          row({
            followUpId: `followup-${index}`,
            sessionId: `s${index}`,
            title: `Follow-up ${index}`,
          }),
        )}
        dismissedIds={new Set([petFollowUpStateId("followup-0")])}
      />,
    );
    expect(html).not.toContain('data-pet-follow-up-row="s0"');
    expect(html).toContain('data-pet-follow-up-row="s20"');
    expect(html).not.toContain('data-pet-follow-up-row="s21"');
  });

  test("renders nothing when there are no rows", () => {
    expect(renderToStaticMarkup(<PetFollowUpSectionView rows={[]} />)).toBe("");
  });

  test("renders nothing when every row is dismissed", () => {
    const html = renderToStaticMarkup(
      <PetFollowUpSectionView
        rows={[row()]}
        dismissedIds={new Set([petFollowUpStateId("followup-s1")])}
      />,
    );
    expect(html).toBe("");
  });

  test("uses a follow-up-specific state id instead of hiding the completed session", () => {
    expect(petFollowUpStateId("followup-abc")).toBe("follow-up:followup-abc");
    expect(petFollowUpStateId("followup-abc")).not.toBe("completed:abc");
  });
});
