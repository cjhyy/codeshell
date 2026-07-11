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

function findElements(node: unknown, tagName: string): unknown[] {
  const current = node as { tagName?: string; childNodes?: unknown[] };
  return [
    ...(current.tagName === tagName ? [current] : []),
    ...(current.childNodes ?? []).flatMap((child) => findElements(child, tagName)),
  ];
}

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
        root?.render(
          <CCRoomView
            cwd="/repo/main"
            active
            openRequest={request}
            onOpenRequestConsumed={(nonce) => {
              if (request.nonce === nonce) request = { ...request, consumed: true };
            }}
          />,
        );
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

    request = { ...request, nonce: 2, consumed: false };
    await render();
    expect(opened).toHaveLength(2);
  });

  test("a parent-consumed request is not replayed after the ccRoom tab remounts", async () => {
    ensureMiniDom();
    const opened: string[] = [];
    Object.assign(window, {
      codeshell: {
        ccRoom: {
          probe: async () => ({ available: true }),
          codexProbe: async () => ({ available: true }),
          listSessions: async () => ({ sessions: [], total: 0 }),
          listCodexSessions: async () => ({ sessions: [], total: 0 }),
          openLinkedSession: async (sessionId: string) => {
            opened.push(sessionId);
            return { roomId: "room_1_abcdef", status: "running", mode: "default" };
          },
        },
      },
    });
    let request: OpenCliSessionRequest = {
      nonce: 7,
      externalSessionId: "thread-remount",
      cliKind: "claude-code",
      cwd: "/repo",
    };
    const mount = async () => {
      const container = document.createElement("div");
      root = createRoot(container);
      await act(async () => {
        root?.render(
          <CCRoomView
            cwd="/repo"
            openRequest={request}
            onOpenRequestConsumed={(nonce) => {
              if (nonce === request.nonce) request = { ...request, consumed: true };
            }}
          />,
        );
        await flushMicrotasks();
        await flushMicrotasks();
      });
    };

    await mount();
    expect(opened).toEqual(["thread-remount"]);
    await act(async () => root?.unmount());
    root = null;
    await mount();
    expect(opened).toEqual(["thread-remount"]);
  });

  test("ignores a late Claude probe after a Codex deep link opens", async () => {
    ensureMiniDom();
    let resolveClaude!: (value: { available: boolean }) => void;
    let resolveCodex!: (value: { available: boolean }) => void;
    const claudeProbe = new Promise<{ available: boolean }>((resolve) => {
      resolveClaude = resolve;
    });
    const codexProbe = new Promise<{ available: boolean }>((resolve) => {
      resolveCodex = resolve;
    });
    let claudeCalls = 0;
    let codexCalls = 0;
    const opened: string[] = [];
    Object.assign(window, {
      codeshell: {
        ccRoom: {
          probe: () => {
            claudeCalls += 1;
            return claudeProbe;
          },
          codexProbe: () => {
            codexCalls += 1;
            return codexProbe;
          },
          listSessions: async () => ({ sessions: [], total: 0 }),
          listCodexSessions: async () => ({ sessions: [], total: 0 }),
          openLinkedSession: async (sessionId: string) => {
            opened.push(sessionId);
            return { roomId: "room_codex", status: "running", mode: "default" };
          },
        },
      },
    });
    const container = document.createElement("div");
    root = createRoot(container);
    await act(async () => {
      root?.render(<CCRoomView cwd="/repo" />);
      await flushMicrotasks();
    });
    const request: OpenCliSessionRequest = {
      nonce: 9,
      externalSessionId: "codex-thread",
      cliKind: "codex",
      cwd: "/repo",
    };
    await act(async () => {
      root?.render(
        <CCRoomView cwd="/repo" openRequest={request} onOpenRequestConsumed={() => undefined} />,
      );
      await flushMicrotasks();
    });
    await act(async () => {
      resolveCodex({ available: true });
      await flushMicrotasks();
      await flushMicrotasks();
    });
    expect(opened).toEqual(["codex-thread"]);
    expect(conversationProps).toMatchObject({ roomId: "room_codex", cliKind: "codex" });

    await act(async () => {
      resolveClaude({ available: false });
      await flushMicrotasks();
    });
    expect(conversationProps).toMatchObject({ roomId: "room_codex", cliKind: "codex" });
    expect(claudeCalls).toBe(1);
    expect(codexCalls).toBe(1);
  });

  test("leaves the loading state and never opens a linked room when the CLI probe rejects", async () => {
    ensureMiniDom();
    let openCalls = 0;
    Object.assign(window, {
      codeshell: {
        ccRoom: {
          probe: async () => {
            throw new Error("probe failed");
          },
          codexProbe: async () => ({ available: true }),
          listSessions: async () => ({ sessions: [], total: 0 }),
          listCodexSessions: async () => ({ sessions: [], total: 0 }),
          openLinkedSession: async () => {
            openCalls += 1;
            return { roomId: "room_never", status: "running", mode: "default" };
          },
        },
      },
    });
    const container = document.createElement("div");
    root = createRoot(container);
    await act(async () => {
      root?.render(
        <CCRoomView
          cwd="/repo"
          openRequest={{
            nonce: 11,
            externalSessionId: "claude-thread",
            cliKind: "claude-code",
            cwd: "/repo",
          }}
          onOpenRequestConsumed={() => undefined}
        />,
      );
      await flushMicrotasks();
      await flushMicrotasks();
    });

    expect(openCalls).toBe(0);
    // CLI switch (2) + retry button (1). The loading state has only the switch.
    expect(findElements(container, "BUTTON")).toHaveLength(3);
  });
});
