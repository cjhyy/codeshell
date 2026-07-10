import { describe, expect, it } from "bun:test";
import type { StreamEvent } from "@cjhyy/code-shell-core";
import { INITIAL_STATE } from "./types";
import { transcriptsReducer, type TranscriptsMap } from "./transcriptsReducer";
import { foldTranscript } from "./automation/foldTranscript";
import type { FoldItem } from "../preload/types";

describe("transcriptsReducer pending steer bubbles", () => {
  it("evicts only the requested transcript bucket", () => {
    const one = { ...INITIAL_STATE, snapshotSeq: 3 };
    const two = { ...INITIAL_STATE, snapshotSeq: 7 };

    const next = transcriptsReducer({ one, two }, { type: "evict", bucket: "one" });

    expect(next).toEqual({ two });
    expect(transcriptsReducer(next, { type: "evict", bucket: "missing" })).toBe(next);
  });

  it("advances snapshotSeq after applying a stream batch", () => {
    let map: TranscriptsMap = {};
    map = transcriptsReducer(map, {
      type: "stream_batch",
      bucket: "b",
      maxSeq: 12,
      events: [
        { type: "stream_request_start", turnNumber: 1 } as StreamEvent,
        { type: "text_delta", text: "hello" } as StreamEvent,
      ],
    });

    expect(map.b.snapshotSeq).toBe(12);
    const assistant = map.b.messages.find((m) => m.kind === "assistant");
    expect(assistant).toMatchObject({ kind: "assistant", text: "hello" });
  });

  it("does not move snapshotSeq backwards for an older stream batch", () => {
    let map: TranscriptsMap = {
      b: { ...INITIAL_STATE, snapshotSeq: 12 },
    };
    map = transcriptsReducer(map, {
      type: "stream_batch",
      bucket: "b",
      maxSeq: 10,
      events: [{ type: "usage_update", promptTokens: 5 } as StreamEvent],
    });

    expect(map.b.snapshotSeq).toBe(12);
  });

  it("removes optimistic pending steer bubbles by steer id", () => {
    let map: TranscriptsMap = {};
    map = transcriptsReducer(map, {
      type: "user_message",
      bucket: "b",
      text: "queued draft",
      injected: true,
      steerId: "q-1",
      pending: true,
    });

    map = transcriptsReducer(map, {
      type: "remove_pending_steers",
      bucket: "b",
      steerIds: ["q-1"],
    });

    expect(map.b.messages).toEqual([]);
  });

  it("keeps pending steers across hydrate and confirms them without duplication", () => {
    let map: TranscriptsMap = {};
    map = transcriptsReducer(map, {
      type: "user_message",
      bucket: "b",
      text: "queued draft",
      injected: true,
      steerId: "q-1",
      pending: true,
    });

    map = transcriptsReducer(map, {
      type: "hydrate",
      bucket: "b",
      state: INITIAL_STATE,
    });
    expect(map.b.messages).toHaveLength(1);
    expect(map.b.messages[0]).toMatchObject({ steerId: "q-1", pending: true });

    map = transcriptsReducer(map, {
      type: "stream",
      bucket: "b",
      event: { type: "steer_injected", id: "q-1", text: "confirmed" } as StreamEvent,
    });

    const users = map.b.messages.filter((m) => m.kind === "user");
    expect(users).toHaveLength(1);
    expect(users[0]).toMatchObject({ text: "confirmed", steerId: "q-1", pending: false });
  });

  // Regression guard for the "queue shows no right-side bubble; it appears only
  // when consumed" behavior. queueInput no longer optimistically dispatches a
  // pending user_message — the queued draft lives ONLY in the left waiting
  // panel until the engine echoes steer_injected. So steer_injected must be
  // able to materialize the bubble WITHOUT a pre-existing pending one (the
  // fallback-append path). If this ever regresses to upgrade-only, removing the
  // optimistic dispatch would make consumed steers vanish from the feed.
  it("appends a user bubble on steer_injected with no prior optimistic bubble", () => {
    let map: TranscriptsMap = {};
    map = transcriptsReducer(map, {
      type: "stream",
      bucket: "b",
      event: { type: "steer_injected", id: "q-1", text: "consumed at last" } as StreamEvent,
    });

    const users = map.b.messages.filter((m) => m.kind === "user");
    expect(users).toHaveLength(1);
    // Must carry the steerId so hydrate's guard protects/dedupes it against the
    // disk replay of the same steer — no loss, no duplicate.
    expect(users[0]).toMatchObject({
      text: "consumed at last",
      injected: true,
      steerId: "q-1",
      pending: false,
    });
  });

  // With no optimistic bubble, the feed bubble is born from steer_injected. A
  // later hydrate whose snapshot replays the SAME steerId must not duplicate it.
  it("does not duplicate a steer_injected-born bubble when hydrate replays its steerId", () => {
    let map: TranscriptsMap = {};
    map = transcriptsReducer(map, {
      type: "stream",
      bucket: "b",
      event: { type: "steer_injected", id: "q-9", text: "check the logs" } as StreamEvent,
    });
    map = transcriptsReducer(map, {
      type: "hydrate",
      bucket: "b",
      state: {
        ...map.b,
        messages: [
          { kind: "user", id: "srv", text: "check the logs", injected: true, steerId: "q-9" },
        ],
      },
    });
    const users = map.b.messages.filter((m) => m.kind === "user");
    expect(users).toHaveLength(1);
  });

  it("keeps a CONFIRMED steer bubble when a lagging snapshot lacks it (no loss)", () => {
    // The bug (session s-mr8s3w5i): steer_injected confirmed the bubble
    // (pending:false), then a hydrate fired before the disk transcript's
    // append was visible to the reader → the snapshot has no matching steerId
    // and the old guard (pending-only) wiped the bubble.
    let map: TranscriptsMap = {};
    map = transcriptsReducer(map, {
      type: "user_message",
      bucket: "b",
      text: "直接搜一下 给我第8个",
      injected: true,
      steerId: "q-1",
      pending: false,
    });

    map = transcriptsReducer(map, {
      type: "hydrate",
      bucket: "b",
      state: INITIAL_STATE, // snapshot lagged — steerId not yet on disk
    });

    const users = map.b.messages.filter((m) => m.kind === "user");
    expect(users).toHaveLength(1);
    expect(users[0]).toMatchObject({ text: "直接搜一下 给我第8个", steerId: "q-1" });
  });

  it("does NOT duplicate a confirmed steer bubble when the snapshot already carries its steerId", () => {
    // Once core persists the steerId (plan A), the disk snapshot replays the
    // same bubble with the same steerId. Hydrate must keep exactly one.
    let map: TranscriptsMap = {};
    map = transcriptsReducer(map, {
      type: "user_message",
      bucket: "b",
      text: "confirmed",
      injected: true,
      steerId: "q-1",
      pending: false,
    });

    map = transcriptsReducer(map, {
      type: "hydrate",
      bucket: "b",
      state: {
        ...INITIAL_STATE,
        messages: [
          { kind: "user", id: "srv-1", text: "confirmed", injected: true, steerId: "q-1" },
        ],
      },
    });

    const users = map.b.messages.filter((m) => m.kind === "user" && m.steerId === "q-1");
    expect(users).toHaveLength(1);
  });

  it("deduplicates local user messages by clientMessageId", () => {
    let map: TranscriptsMap = {};
    map = transcriptsReducer(map, {
      type: "user_message",
      bucket: "b",
      text: "same intent",
      clientMessageId: "client-1",
    });
    map = transcriptsReducer(map, {
      type: "user_message",
      bucket: "b",
      text: "same intent",
      clientMessageId: "client-1",
    });

    expect(map.b.messages.filter((m) => m.kind === "user")).toHaveLength(1);
  });

  it("does NOT duplicate a local message when hydrate already carries its clientMessageId", () => {
    let map: TranscriptsMap = {};
    map = transcriptsReducer(map, {
      type: "user_message",
      bucket: "b",
      text: "confirmed",
      clientMessageId: "client-1",
    });

    map = transcriptsReducer(map, {
      type: "hydrate",
      bucket: "b",
      state: {
        ...INITIAL_STATE,
        messages: [{ kind: "user", id: "srv-1", text: "confirmed", clientMessageId: "client-1" }],
      },
    });

    const users = map.b.messages.filter(
      (m) => m.kind === "user" && m.clientMessageId === "client-1",
    );
    expect(users).toHaveLength(1);
  });

  it("downgrades an idle steer as a normal user message without carrying steerId", () => {
    let map: TranscriptsMap = {};
    map = transcriptsReducer(map, {
      type: "user_message",
      bucket: "b",
      text: "queued while busy",
      injected: true,
      steerId: "steer-1",
      pending: true,
      clientMessageId: "client-1",
    });
    map = transcriptsReducer(map, {
      type: "remove_pending_steers",
      bucket: "b",
      steerIds: ["steer-1"],
    });
    map = transcriptsReducer(map, {
      type: "user_message",
      bucket: "b",
      text: "queued while busy",
      clientMessageId: "client-1",
    });

    const users = map.b.messages.filter((m) => m.kind === "user");
    expect(users).toHaveLength(1);
    expect(users[0]).toMatchObject({ text: "queued while busy", clientMessageId: "client-1" });
    expect(users[0]!.steerId).toBeUndefined();
    expect(users[0]!.injected).toBeUndefined();
  });

  it("replays s-mr8uh4ru-style duplicate submits by clientMessageId, not text or steerId", () => {
    const items: FoldItem[] = [
      {
        kind: "user",
        text: "而且2个steer 都没有一起合并输入",
        clientMessageId: "old-orphan-without-steer-id",
      },
      { kind: "user", text: "same submit", clientMessageId: "client-dup" },
      { kind: "user", text: "same submit", clientMessageId: "client-dup" },
      { kind: "user", text: "same submit", clientMessageId: "client-legit-repeat" },
    ];

    const state = foldTranscript(items);
    const oldOrphan = state.messages.find(
      (m) => m.kind === "user" && m.clientMessageId === "old-orphan-without-steer-id",
    );
    const duplicateSubmit = state.messages.filter(
      (m) => m.kind === "user" && m.clientMessageId === "client-dup",
    );
    const repeatedText = state.messages.filter(
      (m) => m.kind === "user" && m.text === "same submit",
    );

    expect(oldOrphan).toMatchObject({
      text: "而且2个steer 都没有一起合并输入",
      clientMessageId: "old-orphan-without-steer-id",
    });
    expect(oldOrphan!.steerId).toBeUndefined();
    expect(oldOrphan!.injected).toBeUndefined();
    expect(duplicateSubmit).toHaveLength(1);
    expect(repeatedText).toHaveLength(2);
  });
});
