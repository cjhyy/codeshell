import { afterEach, describe, expect, test } from "bun:test";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ensureMiniDom, flushMicrotasks } from "../test-utils/renderHook";
import { CCConversationView } from "./CCConversationView";

let root: Root | null = null;

afterEach(async () => {
  if (root) {
    await act(async () => {
      root?.unmount();
      await flushMicrotasks();
    });
  }
  root = null;
});

describe("CCConversationView transcript ownership", () => {
  test("switching foreground rooms unsubscribes A, subscribes B, then resubscribes A", async () => {
    ensureMiniDom();
    const lifecycle: string[] = [];
    const off = () => undefined;
    (window as unknown as { codeshell: Record<string, unknown> }).codeshell = {
      ccRoom: {
        onApprovalRequest: () => off,
        onApprovalResolved: () => off,
        onRoomMessage: () => off,
        subscribeTranscript: async (roomId: string) => {
          lifecycle.push(`subscribe:${roomId}`);
          return { messages: [], roomCursor: 0 };
        },
        unsubscribeTranscript: async (roomId: string) => {
          lifecycle.push(`unsubscribe:${roomId}`);
        },
        roomHistory: async () => [],
        readHistory: async () => ({ messages: [] }),
        readCodexHistory: async () => ({ messages: [] }),
        send: async () => undefined,
        respondApproval: async () => undefined,
      },
    };

    const container = document.createElement("div");
    root = createRoot(container);

    const renderForeground = async (foreground: "room-a" | "room-b") => {
      await act(async () => {
        root?.render(
          <>
            <CCConversationView
              roomId="room-a"
              cwd="/repo-a"
              sessionId="session-a"
              mode="default"
              active={foreground === "room-a"}
              onBack={() => undefined}
            />
            <CCConversationView
              roomId="room-b"
              cwd="/repo-b"
              sessionId="session-b"
              mode="default"
              active={foreground === "room-b"}
              onBack={() => undefined}
            />
          </>,
        );
        await flushMicrotasks();
      });
    };

    await renderForeground("room-a");
    expect(lifecycle).toEqual(["subscribe:room-a"]);

    await renderForeground("room-b");
    expect(lifecycle).toEqual(["subscribe:room-a", "unsubscribe:room-a", "subscribe:room-b"]);

    await renderForeground("room-a");
    expect(lifecycle).toEqual([
      "subscribe:room-a",
      "unsubscribe:room-a",
      "subscribe:room-b",
      "unsubscribe:room-b",
      "subscribe:room-a",
    ]);
  });
});
