import { describe, expect, test } from "bun:test";
import {
  filterNewRoomMessages,
  clearUnreadSession,
  markSessionUnread,
  markRoomSeqApplied,
  maxRoomSeq,
  noteSessionSeq,
  pruneUnreadSessions,
  rawApprovalResolvedRequestId,
  removeResolvedApproval,
  selectSessionReplayEntries,
} from "./remoteAppSync";

describe("mobile remote app sync helpers", () => {
  test("session snapshot replay appends only entries past the applied cursor", () => {
    const selected = selectSessionReplayEntries(
      [
        { seq: 1, event: { type: "text_delta", text: "old" } },
        { seq: 2, event: { type: "text_delta", text: "new" } },
        { seq: 3, event: { type: "turn_complete" } },
      ],
      1,
    );

    expect(selected.events).toEqual([
      { type: "text_delta", text: "new" },
      { type: "turn_complete" },
    ]);
    expect(selected.cursor).toBe(3);
  });

  test("raw agent/approvalResolved extracts requestId and clears only that card", () => {
    const requestId = rawApprovalResolvedRequestId({
      method: "agent/approvalResolved",
      params: { requestId: "ask-1", sessionId: "s1" },
    });

    expect(requestId).toBe("ask-1");
    expect(
      removeResolvedApproval(
        [
          { requestId: "ask-1", label: "old" },
          { requestId: "ask-2", label: "keep" },
        ],
        requestId!,
      ),
    ).toEqual([{ requestId: "ask-2", label: "keep" }]);
  });

  test("room history merge skips already-applied seq without dropping unseen messages", () => {
    const applied = new Map<string, Set<number>>();
    markRoomSeqApplied(applied, "room-1", 12);

    const fresh = filterNewRoomMessages(
      "room-1",
      [
        { seq: 11, text: "missed" },
        { seq: 12, text: "live duplicate" },
        { seq: 13, text: "new" },
      ],
      applied,
    );

    expect(fresh).toEqual([
      { seq: 11, text: "missed" },
      { seq: 13, text: "new" },
    ]);
    expect(maxRoomSeq(10, fresh, 13)).toBe(13);
  });

  test("room live merge treats a repeated seq as an idempotent no-op", () => {
    const applied = new Map<string, Set<number>>();
    markRoomSeqApplied(applied, "room-1", 7);

    expect(filterNewRoomMessages("room-1", [{ seq: 7, text: "duplicate live" }], applied)).toEqual(
      [],
    );
  });

  test("session unread state uses monotonically increasing seq and clears on open", () => {
    const latestSeqs = new Map<string, number>();
    let unread = new Set<string>();

    if (noteSessionSeq(latestSeqs, "s2", 1)) {
      unread = markSessionUnread(unread, "s2", "s1");
    }

    expect([...unread]).toEqual(["s2"]);
    expect(noteSessionSeq(latestSeqs, "s2", 1)).toBe(false);
    expect(noteSessionSeq(latestSeqs, "s2", 0)).toBe(false);

    unread = clearUnreadSession(unread, "s2");
    expect([...unread]).toEqual([]);
  });

  test("session unread state does not mark active sessions and prunes removed rows", () => {
    let unread = new Set<string>(["s2", "stale"]);

    unread = markSessionUnread(unread, "s1", "s1");
    expect([...unread].sort()).toEqual(["s2", "stale"]);

    unread = pruneUnreadSessions(unread, ["s1", "s2"]);
    expect([...unread]).toEqual(["s2"]);
  });
});
