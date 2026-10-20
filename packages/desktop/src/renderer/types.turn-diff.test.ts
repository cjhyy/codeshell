import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MessageStream } from "./MessageStream";
import { translate } from "./i18n/translate";
import { loadUILanguage } from "./uiLanguage";
import type { StreamEvent, TurnDiffSnapshot } from "@cjhyy/code-shell-core";
import { parseUnifiedDiff } from "./diff/parseUnifiedDiff";
import {
  INITIAL_STATE,
  applyStreamEvent,
  appendUserMessage,
  type FilesChangedSummaryMessage,
  type MessagesReducerState,
} from "./types";

const finalDiff = [
  "diff --git a/src/a.ts b/src/a.ts",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -398,5 +398,5 @@",
  " context398",
  " context399",
  "-A",
  "+C",
  " context401",
  " context402",
  "",
].join("\n");

function start(state = INITIAL_STATE, turnId = "turn-1"): MessagesReducerState {
  state = appendUserMessage(
    state,
    turnId,
    1,
    false,
    false,
    undefined,
    undefined,
    `client:${turnId}`,
  );
  return applyStreamEvent(state, {
    type: "session_started",
    sessionId: "session",
    promptTokens: 0,
    runId: turnId,
    clientMessageId: `client:${turnId}`,
  });
}

function snapshot(
  overrides: Partial<TurnDiffSnapshot> = {},
): Extract<StreamEvent, { type: "turn_diff" }> {
  return {
    type: "turn_diff",
    turnId: "turn-1",
    cwd: "/repo",
    trackedPaths: ["/repo/src/a.ts"],
    toolCallIds: ["edit-1", "edit-2"],
    complete: true,
    omissions: [],
    files: [{ path: "/repo/src/a.ts", status: "modified", added: 1, removed: 1, diff: finalDiff }],
    ...overrides,
  };
}

function edit(
  state: MessagesReducerState,
  id: string,
  from: string,
  to: string,
  path = "src/a.ts",
) {
  state = applyStreamEvent(state, {
    type: "tool_use_start",
    toolCall: { id, toolName: "Edit", args: { file_path: path, old_string: from, new_string: to } },
  });
  return applyStreamEvent(state, {
    type: "tool_result",
    result: { id, toolName: "Edit", result: "Successfully edited", isError: false },
  });
}

function cards(state: MessagesReducerState): FilesChangedSummaryMessage[] {
  return state.messages.filter(
    (message): message is FilesChangedSummaryMessage => message.kind === "files_changed",
  );
}

const complete: StreamEvent = { type: "turn_complete", reason: "completed" };

describe("execution-owned turn diff", () => {
  test("replaces both edit previews with one real-coordinate original-to-final diff during streaming", () => {
    let state = edit(start(), "edit-1", "A", "B");
    state = edit(state, "edit-2", "B", "C", "/repo/src/a.ts");
    state = applyStreamEvent(state, snapshot());
    expect(cards(state)).toHaveLength(1);
    expect(cards(state)[0].files).toEqual([
      { path: "/repo/src/a.ts", added: 1, removed: 1, count: 2 },
    ]);
    expect(cards(state)[0].sessionDiffs).toHaveLength(1);
    expect(cards(state)[0].sessionDiffs?.[0].diff).toBe(finalDiff);
    const parsed = parseUnifiedDiff(cards(state)[0].sessionDiffs![0].diff);
    expect(parsed[0].hunks[0].lines.find((line) => line.kind === "add")?.newLine).toBe(400);
    state = applyStreamEvent(state, complete);
    expect(cards(state)).toHaveLength(1);
    expect(cards(state)[0].sessionDiffs?.[0].diff).toBe(finalDiff);
  });

  test("a net-zero snapshot removes its card and suppresses all recorded payload previews", () => {
    let state = edit(start(), "edit-1", "A", "B");
    state = applyStreamEvent(state, snapshot());
    state = edit(state, "edit-2", "B", "A");
    state = applyStreamEvent(state, snapshot({ files: [] }));
    expect(cards(state)).toHaveLength(0);
    state = applyStreamEvent(state, complete);
    expect(cards(state)).toHaveLength(0);
    expect(
      state.messages.filter((message) => message.kind === "system" && message.turnDiff),
    ).toHaveLength(1);
  });

  test("an injected continuation keeps the original turn aggregate", () => {
    let state = applyStreamEvent(start(), snapshot());
    state = applyStreamEvent(state, complete);
    state = appendUserMessage(
      state,
      "continue",
      2,
      false,
      true,
      undefined,
      undefined,
      "continuation",
    );
    state = applyStreamEvent(state, {
      type: "session_started",
      sessionId: "session",
      promptTokens: 0,
      runId: "run-2",
      clientMessageId: "continuation",
    });
    state = applyStreamEvent(state, { ...snapshot({ files: [] }), runId: "run-2" });
    state = applyStreamEvent(state, { ...complete, runId: "run-2" });
    expect(cards(state)).toHaveLength(0);
  });

  test("late updates change their original turn without moving a newer turn's card or streaming state", () => {
    let state = applyStreamEvent(start(), snapshot());
    state = applyStreamEvent(state, complete);
    state = start(state, "turn-2");
    state = applyStreamEvent(
      state,
      snapshot({
        turnId: "turn-2",
        files: [{ path: "/repo/b.ts", status: "added", added: 1, removed: 0, diff: "new diff" }],
        trackedPaths: ["/repo/b.ts"],
        toolCallIds: ["write-2"],
      }),
    );
    const second = cards(state)[1];
    const pointers = [state.streamingAssistantId, state.activeStreamRunKey, state.turnEpoch];
    state = applyStreamEvent(state, { ...snapshot({ files: [] }), runId: "turn-1" });
    expect(cards(state)).toEqual([second]);
    expect([state.streamingAssistantId, state.activeStreamRunKey, state.turnEpoch]).toEqual(
      pointers,
    );
    const secondUser = state.messages.findIndex(
      (message) => message.kind === "user" && message.sourceEventId === "turn-2",
    );
    expect(
      state.messages
        .slice(secondUser)
        .some((message) => message.kind === "system" && message.turnDiff?.turnId === "turn-1"),
    ).toBe(false);
  });

  test("an older delayed same-turn snapshot cannot overwrite a newer net-zero capture", () => {
    let state = edit(start(), "edit-1", "A", "B");
    state = applyStreamEvent(state, { ...snapshot({ files: [] }), timestamp: 40 });
    const next = applyStreamEvent(state, { ...snapshot(), timestamp: 20 });
    expect(next).toBe(state);
    expect(cards(next)).toHaveLength(0);
  });

  test("child and unknown historical turn diffs cannot replace the parent's aggregate", () => {
    const state = applyStreamEvent(start(), snapshot());
    expect(applyStreamEvent(state, { ...snapshot({ files: [] }), agentId: "child" })).toBe(state);
    expect(applyStreamEvent(state, snapshot({ turnId: "not-loaded", files: [] }))).toBe(state);
  });

  test("omitted files never fall back to fabricated snippets, and retain an explicit incomplete notice", () => {
    let state = edit(start(), "edit-1", "A", "B");
    state = applyStreamEvent(
      state,
      snapshot({
        files: [],
        complete: false,
        omissions: [{ path: "/repo/src/a.ts", reason: "file exceeds capture limit" }],
      }),
    );
    state = applyStreamEvent(state, complete);
    expect(cards(state)).toHaveLength(0);
    const marker = state.messages.find((message) => message.kind === "system" && message.turnDiff);
    expect(marker?.kind === "system" && marker.text).toContain("/repo/src/a.ts");
    expect(marker?.kind === "system" && marker.text).toContain("file exceeds capture limit");
  });

  test("a late child write retains its operation evidence until a newer execution capture replaces it", () => {
    let state = edit(start(), "edit-1", "A", "B");
    state = applyStreamEvent(state, { ...snapshot({ toolCallIds: ["edit-1"] }), timestamp: 10 });
    state = applyStreamEvent(state, {
      type: "agent_start",
      agentId: "child",
      description: "child",
    });
    state = applyStreamEvent(state, {
      type: "tool_use_start",
      agentId: "child",
      timestamp: 20,
      toolCall: {
        id: "child-edit",
        toolName: "Edit",
        args: { file_path: "src/a.ts", old_string: "B", new_string: "C" },
      },
    });
    state = applyStreamEvent(state, {
      type: "tool_result",
      agentId: "child",
      timestamp: 30,
      result: { id: "child-edit", toolName: "Edit", result: "done", isError: false },
    });
    expect(cards(state)).toHaveLength(1);
    const previews = cards(state)[0].sessionDiffs![0].diff;
    expect(previews).toContain("+B");
    expect(previews).toContain("+C");
    const notice = state.messages.find((message) => message.kind === "system" && message.turnDiff);
    expect(notice?.kind === "system" && notice.text.length).toBeGreaterThan(0);
    state = applyStreamEvent(state, { ...snapshot({ toolCallIds: ["edit-1"] }), timestamp: 40 });
    expect(cards(state)[0].sessionDiffs?.map((item) => item.diff)).toEqual([finalDiff]);
    const refreshed = state.messages.find(
      (message) => message.kind === "system" && message.turnDiff,
    );
    expect(refreshed?.kind === "system" && refreshed.text).toBe("");
  });

  test("delayed delivery retains the original capture time when checking later child edits", () => {
    let state = edit(start(), "edit-1", "A", "B");
    state = applyStreamEvent(state, {
      ...snapshot({ toolCallIds: ["edit-1"], capturedAt: 10 }),
      timestamp: 10,
    });
    state = applyStreamEvent(state, {
      type: "agent_start",
      agentId: "child",
      description: "child",
    });
    state = applyStreamEvent(state, {
      type: "tool_use_start",
      agentId: "child",
      timestamp: 20,
      toolCall: {
        id: "child-edit",
        toolName: "Edit",
        args: { file_path: "src/a.ts", old_string: "B", new_string: "C" },
      },
    });
    state = applyStreamEvent(state, {
      type: "tool_result",
      agentId: "child",
      timestamp: 30,
      result: { id: "child-edit", toolName: "Edit", result: "done", isError: false },
    });
    state = applyStreamEvent(state, {
      ...snapshot({ toolCallIds: ["edit-1"], capturedAt: 10 }),
      timestamp: 100,
    });
    const marker = state.messages.find((message) => message.kind === "system" && message.turnDiff);
    expect(marker?.kind === "system" && marker.turnDiffCapturedAt).toBe(10);
    expect(marker?.kind === "system" && marker.turnDiff?.capturedAt).toBe(10);
    expect(marker?.kind === "system" && marker.text.length).toBeGreaterThan(0);
    expect(cards(state)[0].sessionDiffs![0].diff).toContain("+B");
    expect(cards(state)[0].sessionDiffs![0].diff).toContain("+C");
  });

  test("older untracked tools retain their preview alongside an authoritative tracked file", () => {
    let state = edit(start(), "legacy-edit", "old", "new", "legacy.ts");
    state = applyStreamEvent(state, snapshot());
    expect(cards(state)[0].files.map((file) => file.path)).toEqual(["legacy.ts", "/repo/src/a.ts"]);
    expect(cards(state)[0].sessionDiffs).toHaveLength(2);
  });
});

function driveComplete(state: MessagesReducerState, cwd = "/repo", changedFiles = ["src/a.ts"]) {
  return applyStreamEvent(state, {
    type: "background_agent_completed",
    agentId: `drive:${cwd}`,
    description: "DriveAgent(codex): edit a file",
    status: "completed",
    workKind: "cc",
    finalText: "done",
    cwd,
    changedFiles,
    originClientMessageId: "client:turn-1",
    enqueuedAt: 1,
  });
}

function expectVisibleLateNotice(state: MessagesReducerState, path = "/repo/src/a.ts") {
  const marker = state.messages.find((message) => message.kind === "system" && message.turnDiff);
  if (marker?.kind !== "system") throw new Error("missing turn diff marker");
  const warning = translate(loadUILanguage(), "msg.files.lateChangesDiff");
  expect(marker.text).toContain(warning);
  expect(marker.text).toContain(path);
  // Render the actual public consumer, rather than only inspecting a private
  // unresolvedPaths field that the user would never see.
  const html = renderToStaticMarkup(React.createElement(MessageStream, { messages: [marker] }));
  expect(html).toContain(warning);
  expect(html).toContain(path);
}

describe("execution snapshots and DriveAgent completions", () => {
  test("a late real completion after a net-zero parent capture retains an absolute file card", () => {
    let state = applyStreamEvent(start(), snapshot({ files: [], capturedAt: 10 }));
    state = applyStreamEvent(state, complete);
    expect(cards(state)).toHaveLength(0);
    const before = state;
    state = driveComplete(state);
    expect(cards(state)).toHaveLength(1);
    expect(cards(state)[0].files).toEqual([
      { path: "/repo/src/a.ts", added: 0, removed: 0, count: 1 },
    ]);
    expect(cards(state)[0].sessionDiffs).toEqual([]);
    expectVisibleLateNotice(state);
    expect(
      before.messages.find((message) => message.kind === "system" && message.turnDiff),
    ).toMatchObject({ text: "" });
  });

  test("a late completion never presents the old nonempty snapshot as a final net diff", () => {
    let state = edit(start(), "edit-1", "A", "B", "/repo/src/a.ts");
    state = applyStreamEvent(state, snapshot({ capturedAt: 10 }));
    state = applyStreamEvent(state, complete);
    state = driveComplete(state, "/repo", ["/repo/src/a.ts"]);
    expect(cards(state)).toHaveLength(1);
    const diffs = cards(state)[0].sessionDiffs!.map((item) => item.diff);
    expect(diffs).not.toContain(finalDiff);
    expect(cards(state)[0].files).toEqual([
      { path: "/repo/src/a.ts", added: 1, removed: 1, count: 2 },
    ]);
    expect(diffs.join("\n")).toContain("+B");
    expect(diffs.join("\n")).not.toContain("+C");
    expectVisibleLateNotice(state);
  });

  test("late original-turn attribution leaves the newer turn and streaming pointers intact", () => {
    let state = applyStreamEvent(start(), snapshot({ files: [], capturedAt: 10 }));
    state = applyStreamEvent(state, complete);
    state = applyStreamEvent(
      start(state, "turn-2"),
      snapshot({
        turnId: "turn-2",
        trackedPaths: ["/repo/b.ts"],
        files: [{ path: "/repo/b.ts", status: "added", added: 1, removed: 0, diff: "new diff" }],
      }),
    );
    const secondCard = cards(state)[0];
    const pointers = [state.streamingAssistantId, state.activeStreamRunKey, state.turnEpoch];
    state = driveComplete(state);
    const secondUser = state.messages.findIndex(
      (message) => message.kind === "user" && message.clientMessageId === "client:turn-2",
    );
    expect(cards(state)).toHaveLength(2);
    expect(cards(state)[1]).toEqual(secondCard);
    expect(state.messages.indexOf(cards(state)[0])).toBeLessThan(secondUser);
    expect(cards(state)[0].files[0].path).toBe("/repo/src/a.ts");
    expect([state.streamingAssistantId, state.activeStreamRunKey, state.turnEpoch]).toEqual(
      pointers,
    );
    expectVisibleLateNotice(state);
    const markerCount = state.messages.filter(
      (message) => message.kind === "system" && message.externalFileChanges,
    ).length;
    state = applyStreamEvent(state, snapshot({ files: [], capturedAt: 10_000 }));
    expect(cards(state)).toHaveLength(2);
    expect(cards(state)[1]).toEqual(secondCard);
    expect(cards(state)[0].files[0].path).toBe("/repo/src/a.ts");
    expectVisibleLateNotice(state);
    expect(
      state.messages.filter((message) => message.kind === "system" && message.externalFileChanges),
    ).toHaveLength(markerCount);
  });

  test("a snapshot arriving later cannot prove it captured an external completion without coverage identity", () => {
    let state = driveComplete(start());
    state = applyStreamEvent(state, { ...snapshot({ capturedAt: 1_000 }), timestamp: 2_000 });
    expect(cards(state)).toHaveLength(1);
    expect(cards(state)[0].files).toEqual([
      { path: "/repo/src/a.ts", added: 0, removed: 0, count: 1 },
    ]);
    expect(cards(state)[0].sessionDiffs).toEqual([]);
    expectVisibleLateNotice(state);
    state = applyStreamEvent(state, snapshot({ capturedAt: 10_000, files: [] }));
    expect(cards(state)).toHaveLength(1);
    expectVisibleLateNotice(state);
  });

  test("known execution cwd and external attribution keep a relative preview's absolute open target", () => {
    let state = edit(start(), "edit-1", "A", "B");
    state = applyStreamEvent(state, snapshot());
    state = driveComplete(state);
    expect(cards(state)[0].files).toEqual([
      { path: "/repo/src/a.ts", added: 1, removed: 1, count: 2 },
    ]);
    expect(cards(state)[0].sessionDiffs![0].path).toBe("/repo/src/a.ts");
    expect(parseUnifiedDiff(cards(state)[0].sessionDiffs![0].diff)[0].newPath).toBe(
      "/repo/src/a.ts",
    );
    expectVisibleLateNotice(state);
  });
  test("external late-change notice preserves the capture omission notice and reason", () => {
    let state = applyStreamEvent(
      start(),
      snapshot({
        files: [],
        complete: false,
        omissions: [{ path: "/repo/src/a.ts", reason: "capture unavailable" }],
      }),
    );
    state = driveComplete(state);
    expect(cards(state)[0].files[0].path).toBe("/repo/src/a.ts");
    expectVisibleLateNotice(state);
    const marker = state.messages.find((message) => message.kind === "system" && message.turnDiff);
    expect(marker?.kind === "system" && marker.text).toContain("capture unavailable");
    expect(marker?.kind === "system" && marker.text).toContain(
      translate(loadUILanguage(), "msg.files.incompleteDiff"),
    );
  });

  test("the same relative name in a different external root does not invalidate tracked bytes", () => {
    let state = applyStreamEvent(start(), snapshot());
    state = driveComplete(state, "/other-worktree");
    expect(cards(state)[0].files.map((file) => file.path)).toEqual([
      "/other-worktree/src/a.ts",
      "/repo/src/a.ts",
    ]);
    expect(cards(state)[0].sessionDiffs?.map((item) => item.diff)).toEqual([finalDiff]);
    const marker = state.messages.find((message) => message.kind === "system" && message.turnDiff);
    expect(marker?.kind === "system" && marker.text).toBe("");
  });

  test("legacy completion without a snapshot still preserves its absolute attribution", () => {
    const state = driveComplete(start(), "/owned path", ["报告.ts"]);
    expect(cards(state)[0].files).toEqual([
      { path: "/owned path/报告.ts", added: 0, removed: 0, count: 1 },
    ]);
    expect(state.messages.some((message) => message.kind === "system" && message.turnDiff)).toBe(
      false,
    );
  });
});
