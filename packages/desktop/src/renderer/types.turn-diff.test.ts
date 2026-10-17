import { describe, expect, test } from "bun:test";
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
