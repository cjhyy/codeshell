import { describe, expect, test } from "bun:test";
import type { StreamEvent } from "@cjhyy/code-shell-core";
import {
  applyStreamEvent,
  INITIAL_STATE,
  type MessagesReducerState,
  type Message,
} from "./types";

function withMessages(
  messages: Message[],
  over: Partial<MessagesReducerState> = {},
): MessagesReducerState {
  return { ...INITIAL_STATE, messages, ...over };
}

const turnComplete: StreamEvent = { type: "turn_complete" } as StreamEvent;

describe("applyStreamEvent — turn_complete", () => {
  test("bumps turnEpoch from 0 to 1", () => {
    const next = applyStreamEvent(withMessages([]), turnComplete);
    expect(next.turnEpoch).toBe(1);
  });

  test("bumps turnEpoch on every call", () => {
    let s = withMessages([]);
    s = applyStreamEvent(s, turnComplete);
    s = applyStreamEvent(s, turnComplete);
    s = applyStreamEvent(s, turnComplete);
    expect(s.turnEpoch).toBe(3);
  });

  test("appends files_changed message when turn had successful Edits", () => {
    const messages: Message[] = [
      { kind: "user", id: "u1", text: "edit a.ts" },
      {
        kind: "tool",
        id: "t1",
        toolName: "Edit",
        args: JSON.stringify({ file_path: "a.ts", old_string: "x", new_string: "y\nz" }),
        status: "succeeded",
        startedAt: 0,
      },
    ];
    const next = applyStreamEvent(withMessages(messages), turnComplete);
    const last = next.messages[next.messages.length - 1];
    expect(last.kind).toBe("files_changed");
    if (last.kind === "files_changed") {
      expect(last.files).toEqual([{ path: "a.ts", added: 2, removed: 1, count: 1 }]);
      expect(last.totalAdded).toBe(2);
      expect(last.totalRemoved).toBe(1);
    }
  });

  test("does not append files_changed when no edits happened", () => {
    const messages: Message[] = [
      { kind: "user", id: "u1", text: "just read" },
      {
        kind: "tool",
        id: "t1",
        toolName: "Read",
        args: JSON.stringify({ file_path: "a.ts" }),
        status: "succeeded",
        startedAt: 0,
      },
    ];
    const next = applyStreamEvent(withMessages(messages), turnComplete);
    expect(next.messages.length).toBe(messages.length);
    expect(next.messages.find((m) => m.kind === "files_changed")).toBeUndefined();
  });

  test("replaces stale files_changed within same user-turn (multi turn_complete)", () => {
    const messages: Message[] = [
      { kind: "user", id: "u1", text: "edit twice" },
      {
        kind: "tool",
        id: "t1",
        toolName: "Edit",
        args: JSON.stringify({ file_path: "a.ts", old_string: "x", new_string: "y" }),
        status: "succeeded",
        startedAt: 0,
      },
    ];
    let s = withMessages(messages);
    s = applyStreamEvent(s, turnComplete);
    const firstCardIdx = s.messages.findIndex((m) => m.kind === "files_changed");
    expect(firstCardIdx).toBeGreaterThan(-1);

    s = {
      ...s,
      messages: [
        ...s.messages,
        {
          kind: "tool",
          id: "t2",
          toolName: "Write",
          args: JSON.stringify({ file_path: "b.ts", content: "x\ny\nz" }),
          status: "succeeded",
          startedAt: 0,
        },
      ],
    };
    s = applyStreamEvent(s, turnComplete);

    const cards = s.messages.filter((m) => m.kind === "files_changed");
    expect(cards.length).toBe(1);
    if (cards[0].kind === "files_changed") {
      expect(cards[0].files.length).toBe(2);
    }
  });
});
