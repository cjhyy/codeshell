import { describe, expect, test } from "bun:test";
import { foldTranscript } from "../automation/foldTranscript";
import { mergeHistoryWindows } from "./mergeHistoryWindows";

describe("merging saved and canonical history windows", () => {
  test("keeps a saved prefix anchored by a durable user intent and preserves the new tail", () => {
    const disk = foldTranscript([
      { kind: "user", text: "Continue", clientMessageId: "intent", timestamp: 2 },
    ]);
    const saved = foldTranscript([
      { kind: "user", text: "Legacy-only history", timestamp: 1 },
      { kind: "user", text: "Continue", clientMessageId: "intent", timestamp: 3 },
      { kind: "user", text: "Unflushed tail", clientMessageId: "new", timestamp: 4 },
    ]);
    expect(mergeHistoryWindows(disk, saved).messages).toMatchObject([
      { text: "Legacy-only history" },
      { text: "Continue" },
      { text: "Unflushed tail" },
    ]);
  });

  test("uses timestamp and content for a legacy message without a submit id", () => {
    const disk = foldTranscript([{ kind: "user", text: "Recent", timestamp: 2 }]);
    const saved = foldTranscript([
      { kind: "user", text: "Older", timestamp: 1 },
      { kind: "user", text: "Recent", timestamp: 2 },
    ]);
    expect(mergeHistoryWindows(disk, saved).messages).toMatchObject([
      { text: "Older" },
      { text: "Recent" },
    ]);
  });

  test("does not guess a prefix from repeated text with different timestamps", () => {
    const disk = foldTranscript([{ kind: "user", text: "Continue", timestamp: 5 }]);
    const saved = foldTranscript([
      { kind: "user", text: "Older unrelated turn", timestamp: 1 },
      { kind: "user", text: "Continue", timestamp: 2 },
    ]);
    expect(mergeHistoryWindows(disk, saved).messages).toMatchObject([
      { text: "Continue", createdAt: 5 },
    ]);
  });
});
