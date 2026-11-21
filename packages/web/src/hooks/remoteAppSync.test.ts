import { describe, expect, test } from "bun:test";
import { ctrlSequence, RemoteTerminalChannel } from "./remoteTerminalChannel.js";
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
  rawApprovalResolvedRoute,
  approvalMatchesRoute,
  selectSessionReplayEntries,
} from "./remoteAppSync";
import {
  MAX_ROOMS_WITH_APPROVALS,
  SentRoomApprovals,
  isRoomAssistantOutput,
  noteRoomApproval,
  pruneRoomApprovals,
  roomsThatStopped,
  type RoomApprovalIndex,
} from "./roomAttention";

describe("mobile remote app sync helpers", () => {
  test("resolution matches the precise session, connection and request generation", () => {
    const current = { requestId: "ask-1", sessionId: "s1", connectionId: "worker", generation: 2 };
    const route = rawApprovalResolvedRoute({
      method: "agent/approvalResolved",
      params: { ...current, approved: true },
    });
    expect(route).toEqual(current);
    expect(approvalMatchesRoute(current, route!)).toBe(true);
    for (const changed of [
      { sessionId: "s2" },
      { connectionId: "old-worker" },
      { generation: 1 },
      { requestId: "ask-2" },
    ])
      expect(approvalMatchesRoute(current, { ...route!, ...changed })).toBe(false);
    expect(approvalMatchesRoute(current, { sessionId: "s1", requestId: "ask-1" })).toBe(false);
    expect(
      approvalMatchesRoute(
        { sessionId: "s1", requestId: "ask-1" },
        { sessionId: "s1", requestId: "ask-1" },
      ),
    ).toBe(true);
  });
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

describe("CLI room attention helpers", () => {
  const room = (id: string, open: boolean) => ({
    id,
    name: id,
    cwd: "/repo",
    kind: "claude-code" as const,
    permissionMode: "default" as const,
    createdAt: 1,
    lastActiveAt: 1,
    open,
    observing: false,
  });

  test("only a Host transition from running to not running counts as stopped", () => {
    expect(
      roomsThatStopped(
        [room("a", true), room("b", false), room("c", true)],
        [room("a", false), room("b", false), room("c", true)],
      ),
    ).toEqual(["a"]);
    // A room missing from a later list is unknown, not proven stopped.
    expect(roomsThatStopped([room("a", true)], [])).toEqual([]);
  });

  test("approval index is bounded per room and in rooms; closed rooms are pruned", () => {
    let index: RoomApprovalIndex = new Map();
    for (let n = 0; n < MAX_ROOMS_WITH_APPROVALS + 5; n += 1)
      index = noteRoomApproval(index, `room-${n}`, "r");
    expect(index.size).toBe(MAX_ROOMS_WITH_APPROVALS);
    expect(index.has("room-0")).toBe(false);
    expect(noteRoomApproval(index, "room-9", "r")).toBe(index);
    expect(pruneRoomApprovals(index, [room("room-9", false)]).has("room-9")).toBe(false);
    expect(pruneRoomApprovals(index, [room("room-9", true)])).toBe(index);
  });

  test("assistant prose marks a room unread; tools and user lines do not", () => {
    expect(isRoomAssistantOutput({ from: "agent", type: "text", text: "hi" })).toBe(true);
    expect(isRoomAssistantOutput({ from: "agent", type: "tool" })).toBe(false);
    expect(isRoomAssistantOutput({ from: "user", type: "text" })).toBe(false);
    expect(isRoomAssistantOutput(null)).toBe(false);
  });

  test("sent approval cards are kept bounded and returned once", () => {
    const sent = new SentRoomApprovals<{ requestId: string }>();
    for (let n = 0; n < 30; n += 1) sent.remember({ requestId: `r-${n}` });
    expect(sent.take("r-0")).toBeUndefined();
    expect(sent.take("r-29")).toEqual({ requestId: "r-29" });
    expect(sent.take("r-29")).toBeUndefined();
  });
});

describe("remote terminal channel", () => {
  test("routes only terminal events and re-attaches on every new socket", () => {
    const channel = new RemoteTerminalChannel();
    const seen: string[] = [];
    let reconnects = 0;
    channel.subscribe((event) => seen.push(event.type));
    channel.onReconnect(() => reconnects++);
    expect(channel.accept({ type: "terminal.data", terminalId: "term:x", data: "a" })).toBe(true);
    expect(channel.accept({ type: "session.list.ok", sessions: [] } as never)).toBe(false);
    expect(seen).toEqual(["terminal.data"]);

    const sent: unknown[] = [];
    const send = (event: unknown) => (sent.push(event), true);
    expect(channel.send({ type: "terminal.list" })).toBe(false);
    channel.bind(send, true, 1);
    channel.bind(send, true, 1);
    expect(reconnects).toBe(1);
    expect(channel.send({ type: "terminal.list" })).toBe(true);
    channel.bind(send, false, 1);
    expect(channel.online).toBe(false);
    channel.bind(send, true, 2);
    expect(reconnects).toBe(2);
    expect(sent).toEqual([{ type: "terminal.list" }]);
  });

  test("the phone Ctrl key turns the next letter into a control character", () => {
    expect(ctrlSequence("c")).toBe("\x03");
    expect(ctrlSequence("D")).toBe("\x04");
    expect(ctrlSequence("[")).toBe("\x1b");
    expect(ctrlSequence("1")).toBe("1");
    expect(ctrlSequence("ab")).toBe("ab");
  });
});
