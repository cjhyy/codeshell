import { afterEach, describe, expect, test } from "bun:test";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ensureMiniDom, flushMicrotasks } from "../test-utils/renderHook";
import { CCConversationView } from "./CCConversationView";

let root: Root | null = null;

function reactPropsOf(node: unknown): Record<string, any> {
  const key = Object.keys(node as object).find((candidate) =>
    candidate.startsWith("__reactProps$"),
  );
  return key ? ((node as Record<string, any>)[key] ?? {}) : {};
}

function findElementByProp(node: unknown, prop: string): any {
  const current = node as { childNodes?: unknown[] };
  if (reactPropsOf(current)[prop] !== undefined) return current;
  for (const child of current.childNodes ?? []) {
    const found = findElementByProp(child, prop);
    if (found) return found;
  }
  return undefined;
}

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

  test("observing tails history but disables the composer until explicit takeover", async () => {
    ensureMiniDom();
    let takeovers = 0;
    let sends = 0;
    const off = () => undefined;
    (window as unknown as { codeshell: Record<string, unknown> }).codeshell = {
      ccRoom: {
        onApprovalRequest: () => off,
        onApprovalResolved: () => off,
        onRoomMessage: () => off,
        subscribeTranscript: async () => ({ messages: [], roomCursor: 0 }),
        unsubscribeTranscript: async () => undefined,
        roomHistory: async () => [],
        readHistory: async () => ({ messages: [] }),
        readCodexHistory: async () => ({ messages: [] }),
        send: async () => {
          sends += 1;
        },
        respondApproval: async () => undefined,
      },
    };

    const container = document.createElement("div");
    root = createRoot(container);
    await act(async () => {
      root?.render(
        <CCConversationView
          roomId="room-observe"
          cwd="/repo"
          sessionId="thread-observe"
          mode="default"
          observing
          onTakeOver={async () => {
            takeovers += 1;
          }}
          onBack={() => undefined}
        />,
      );
      await flushMicrotasks();
    });

    expect(findElementByProp(container, "data-cc-room-state")).toBeDefined();
    expect(reactPropsOf(findElementByProp(container, "data-cc-room-composer")).disabled).toBe(true);
    await act(async () => {
      reactPropsOf(findElementByProp(container, "data-cc-room-takeover")).onClick();
      await flushMicrotasks();
    });
    expect(takeovers).toBe(1);
    expect(sends).toBe(0);
  });

  test("keeps the draft when RoomManager rejects a send", async () => {
    ensureMiniDom();
    let sends = 0;
    const off = () => undefined;
    (window as unknown as { codeshell: Record<string, unknown> }).codeshell = {
      ccRoom: {
        onApprovalRequest: () => off,
        onApprovalResolved: () => off,
        onRoomMessage: () => off,
        subscribeTranscript: async () => ({ messages: [], roomCursor: 0 }),
        unsubscribeTranscript: async () => undefined,
        roomHistory: async () => [],
        readHistory: async () => ({ messages: [] }),
        readCodexHistory: async () => ({ messages: [] }),
        send: async () => {
          sends += 1;
          return false;
        },
        respondApproval: async () => undefined,
      },
    };

    const container = document.createElement("div");
    root = createRoot(container);
    await act(async () => {
      root?.render(
        <CCConversationView
          roomId="room-rejected"
          cwd="/repo"
          sessionId="thread-rejected"
          mode="default"
          onBack={() => undefined}
        />,
      );
      await flushMicrotasks();
    });

    await act(async () => {
      reactPropsOf(findElementByProp(container, "data-cc-room-composer")).onChange({
        target: { value: "keep this draft" },
      });
      await flushMicrotasks();
    });
    await act(async () => {
      reactPropsOf(findElementByProp(container, "data-cc-room-composer")).onKeyDown({
        key: "Enter",
        shiftKey: false,
        preventDefault() {},
      });
      await flushMicrotasks();
      await flushMicrotasks();
    });

    expect(sends).toBe(1);
    expect(reactPropsOf(findElementByProp(container, "data-cc-room-composer")).value).toBe(
      "keep this draft",
    );
  });
});
