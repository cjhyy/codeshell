import { describe, expect, test } from "bun:test";
import type { TurnDiffSnapshot } from "@cjhyy/code-shell-core";
import { transcriptToFoldItems } from "./transcript-reader";
import { foldTranscript } from "../renderer/automation/foldTranscript";

function record(type: string, data: Record<string, unknown>, id = "event") {
  return JSON.stringify({ id, type, timestamp: 1, turnNumber: 0, data });
}

const diff = "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-A\n+C\n";
const snapshot: TurnDiffSnapshot = {
  turnId: "user-event",
  cwd: "/repo",
  trackedPaths: ["/repo/a.ts"],
  toolCallIds: ["edit-1", "edit-2"],
  complete: true,
  omissions: [],
  files: [{ path: "/repo/a.ts", status: "modified", diff, added: 1, removed: 1 }],
};

function prefix() {
  return [
    record(
      "message",
      { role: "user", content: "change twice", clientMessageId: "client-1" },
      "user-event",
    ),
    record("tool_use", {
      toolCallId: "edit-1",
      toolName: "Edit",
      args: { file_path: "a.ts", old_string: "A", new_string: "B" },
    }),
    record("tool_result", { toolCallId: "edit-1", toolName: "Edit", result: "ok" }),
    record("tool_use", {
      toolCallId: "edit-2",
      toolName: "Edit",
      args: { file_path: "/repo/a.ts", old_string: "B", new_string: "C" },
    }),
    record("tool_result", { toolCallId: "edit-2", toolName: "Edit", result: "ok" }),
  ];
}

describe("durable turn diff projection", () => {
  test("reopens with one authoritative original-to-final diff instead of operation previews", () => {
    const items = transcriptToFoldItems(
      [...prefix(), record("turn_diff", { ...snapshot }), record("turn_boundary", {})].join("\n"),
    );
    expect(
      items.filter((item) => item.kind === "stream" && item.event.type === "turn_diff"),
    ).toHaveLength(1);
    const state = foldTranscript(items);
    const cards = state.messages.filter((message) => message.kind === "files_changed");
    expect(cards).toHaveLength(1);
    expect(cards[0].kind === "files_changed" && cards[0].files).toEqual([
      { path: "/repo/a.ts", added: 1, removed: 1, count: 2 },
    ]);
    expect(
      cards[0].kind === "files_changed" && cards[0].sessionDiffs?.map((item) => item.diff),
    ).toEqual([diff]);
  });

  test("later persisted net-zero update removes the earlier aggregate after reopen", () => {
    const items = transcriptToFoldItems(
      [
        ...prefix(),
        record("turn_diff", { ...snapshot }),
        record("turn_boundary", {}),
        record(
          "message",
          { role: "user", content: "continue", injected: true, clientMessageId: "continuation" },
          "injected-run",
        ),
        record("turn_diff", { ...snapshot, files: [] }),
        record("turn_boundary", {}),
      ].join("\n"),
    );
    const state = foldTranscript(items);
    expect(state.messages.filter((message) => message.kind === "files_changed")).toHaveLength(0);
    expect(
      state.messages.filter((message) => message.kind === "system" && message.turnDiff),
    ).toHaveLength(1);
  });

  test("a mirrored child snapshot cannot become its parent turn's file diff during replay", () => {
    const items = transcriptToFoldItems(
      [
        record("message", { role: "user", content: "parent" }, "user-event"),
        record("turn_diff", { ...snapshot, agentId: "child" }),
        record("turn_boundary", {}),
      ].join("\n"),
    );
    expect(foldTranscript(items).messages.some((message) => message.kind === "files_changed")).toBe(
      false,
    );
  });

  test("retains actual capture time when reading a later delivered snapshot", () => {
    const items = transcriptToFoldItems(record("turn_diff", { ...snapshot, capturedAt: 12 }));
    expect(items[0].kind === "stream" && items[0].event).toMatchObject({
      type: "turn_diff",
      capturedAt: 12,
    });
  });

  test("rejects malformed persisted snapshots instead of partially adopting their files", () => {
    for (const change of [
      { files: [{ ...snapshot.files[0], added: -1 }] },
      { files: [{ ...snapshot.files[0], status: "renamed" }] },
      { trackedPaths: [null] },
      { toolCallIds: "edit-1" },
      { omissions: [{ path: "/repo/a.ts", reason: null }] },
      { turnId: "" },
      { capturedAt: -1 },
      { capturedAt: null },
    ]) {
      expect(transcriptToFoldItems(record("turn_diff", { ...snapshot, ...change }))).toEqual([]);
    }
  });
});
