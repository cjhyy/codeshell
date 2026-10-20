import { describe, expect, test } from "bun:test";
import type { InputAttachmentMeta } from "../../preload/types";
import {
  bindMentionReference,
  currentMentionReferences,
  reconcileMentionReferences,
} from "./mentionReferences";

const attachment: InputAttachmentMeta = {
  id: "owned",
  sessionId: "session",
  kind: "file",
  origin: "generated",
  path: "/owned/报告 notes.md",
  absPath: "/owned/报告 notes.md",
  size: 1,
  sha256: "owned",
  createdAt: 1,
};
const token = `@${attachment.path}`;
function selected() {
  return bindMentionReference(
    { draft: "", bindings: [] },
    `${token} `,
    0,
    token.length,
    attachment,
  );
}

describe("selected mention text ownership", () => {
  test("prose before and after a spaced Unicode path moves its range without changing metadata", () => {
    const before = selected();
    const shifted = reconcileMentionReferences(before, `Explain ${before.draft}`);
    const appended = reconcileMentionReferences(shifted, `${shifted.draft}please`);
    expect(currentMentionReferences(appended, appended.draft)).toEqual([attachment]);
    expect(currentMentionReferences(appended, appended.draft)[0]).toBe(attachment);
  });

  test.each([".bak", "/child", " copy", "\tcopy"])(
    "editing path suffix %j revokes the old exact selection",
    (suffix) => {
      const state = selected();
      const next = reconcileMentionReferences(state, `${token}${suffix} `, {
        start: token.length,
        end: token.length,
        caret: token.length + suffix.length,
      });
      expect(next.bindings).toEqual([]);
    },
  );

  test("one remaining selected occurrence keeps its reference but an unselected pasted copy cannot revive it", () => {
    const first = selected();
    const duplicateDraft = `${first.draft}${token} `;
    const two = bindMentionReference(
      first,
      duplicateDraft,
      first.draft.length,
      duplicateDraft.length - 1,
      attachment,
    );
    const remaining = reconcileMentionReferences(two, first.draft, {
      start: 0,
      end: first.draft.length,
      caret: 0,
    });
    expect(remaining.bindings).toHaveLength(1);
    expect(currentMentionReferences(remaining, remaining.draft)).toEqual([attachment]);
    const copied = reconcileMentionReferences(first, duplicateDraft);
    const removedSelected = reconcileMentionReferences(copied, first.draft, {
      start: 0,
      end: first.draft.length,
      caret: 0,
    });
    expect(removedSelected.bindings).toEqual([]);
  });

  test("observable programmatic clear and restore cannot reactivate a revoked selection", () => {
    const state = selected();
    const cleared = reconcileMentionReferences(state, "");
    expect(currentMentionReferences(cleared, state.draft)).toEqual([]);
    expect(currentMentionReferences(state, "ordinary message")).toEqual([]);
  });

  test("an actual trailing filename space is distinct from the insertion's separator", () => {
    const paddedToken = "@/owned/ padded.md ";
    const state = bindMentionReference(
      { draft: "", bindings: [] },
      `${paddedToken} `,
      0,
      paddedToken.length,
      attachment,
    );
    const after = reconcileMentionReferences(state, `${state.draft}please`, {
      start: state.draft.length,
      end: state.draft.length,
      caret: state.draft.length + 6,
    });
    expect(currentMentionReferences(after, after.draft)).toEqual([attachment]);
    const trimmed = reconcileMentionReferences(state, `${paddedToken.trimEnd()} `, {
      start: paddedToken.length - 1,
      end: paddedToken.length,
      caret: paddedToken.length - 1,
    });
    expect(trimmed.bindings).toEqual([]);
  });
});
