import { afterEach, describe, expect, mock, test } from "bun:test";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ensureMiniDom, flushMicrotasks } from "../test-utils/renderHook";
import type { OpenCliSessionRequest } from "./types";

let conversationProps: Record<string, unknown> | null = null;

mock.module("./CCConversationView", () => ({
  CCConversationView(props: Record<string, unknown>) {
    conversationProps = props;
    return React.createElement("div", { "data-room": props.roomId });
  },
}));

mock.module("./QuotaPanel", () => ({ QuotaPanel: () => null }));

const { CCRoomView } = await import("./CCRoomView");

let root: Root | null = null;

afterEach(async () => {
  if (root) {
    await act(async () => {
      root?.unmount();
      await flushMicrotasks();
    });
  }
  root = null;
  conversationProps = null;
});

describe("CCRoomView DriveAgent deep links", () => {
  test("opens each request nonce once with the linked cwd, CLI kind, and preserved mode", async () => {
    ensureMiniDom();
    const opened: Array<[string, string, string]> = [];
    Object.assign(window, {
      codeshell: {
        ccRoom: {
          probe: async () => ({ available: true }),
          codexProbe: async () => ({ available: true }),
          listSessions: async () => ({ sessions: [], total: 0 }),
          listCodexSessions: async () => ({ sessions: [], total: 0 }),
          openLinkedSession: async (sessionId: string, cwd: string, kind: string) => {
            opened.push([sessionId, cwd, kind]);
            return { roomId: "room_1_abcdef", status: "running", mode: "acceptEdits" };
          },
        },
      },
    });

    const container = document.createElement("div");
    root = createRoot(container);
    let request: OpenCliSessionRequest = {
      nonce: 1,
      externalSessionId: "thread-1",
      cliKind: "codex",
      cwd: "/repo/worktree",
    };
    const render = async () => {
      await act(async () => {
        root?.render(<CCRoomView cwd="/repo/main" active openRequest={request} />);
        await flushMicrotasks();
        await flushMicrotasks();
      });
    };

    await render();
    expect(opened).toEqual([["thread-1", "/repo/worktree", "codex"]]);
    expect(conversationProps).toMatchObject({
      roomId: "room_1_abcdef",
      cwd: "/repo/worktree",
      sessionId: "thread-1",
      mode: "acceptEdits",
      cliKind: "codex",
    });

    await render();
    expect(opened).toHaveLength(1);

    request = { ...request, nonce: 2 };
    await render();
    expect(opened).toHaveLength(2);
  });
});
