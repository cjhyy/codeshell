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
});
