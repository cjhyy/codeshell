import { describe, expect, it } from "bun:test";
import type { StreamEvent } from "@cjhyy/code-shell-core";
import { INITIAL_STATE } from "./types";
import { transcriptsReducer, type TranscriptsMap } from "./transcriptsReducer";

describe("transcriptsReducer pending steer bubbles", () => {
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
});
