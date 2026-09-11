import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
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

mock.module("@/components/ui/dialog", () => ({
  Dialog: ({ open, children }: { open: boolean; children: React.ReactNode }) =>
    open ? React.createElement("div", null, children) : null,
  DialogContent: ({ children }: { children: React.ReactNode }) =>
    React.createElement("div", null, children),
  DialogHeader: ({ children }: { children: React.ReactNode }) =>
    React.createElement("div", null, children),
  DialogTitle: ({ children }: { children: React.ReactNode }) =>
    React.createElement("div", null, children),
  DialogDescription: ({ children }: { children: React.ReactNode }) =>
    React.createElement("div", null, children),
}));

const { CCRoomView } = await import("./CCRoomView");

let root: Root | null = null;

afterAll(() => {
  mock.restore();
});

function findElements(node: unknown, tagName: string): unknown[] {
  const current = node as { tagName?: string; childNodes?: unknown[] };
  return [
    ...(current.tagName === tagName ? [current] : []),
    ...(current.childNodes ?? []).flatMap((child) => findElements(child, tagName)),
  ];
}

function reactPropsOf(node: unknown): Record<string, any> {
  const key = Object.keys(node as object).find((candidate) =>
    candidate.startsWith("__reactProps$"),
  );
  return key ? ((node as Record<string, any>)[key] ?? {}) : {};
}

function childText(value: unknown): string {
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map(childText).join("");
  if (React.isValidElement(value)) return childText(value.props.children);
  return "";
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
  test("opens a listed delegated session with that session's own cwd", async () => {
    ensureMiniDom();
    const opened: Array<[string, string, string, string]> = [];
    Object.assign(window, {
      codeshell: {
        ccRoom: {
          probe: async () => ({ available: true }),
          codexProbe: async () => ({ available: true }),
          listSessions: async () => ({
            sessions: [
              {
                sessionId: "delegated-session",
                cwd: "/repo/.worktrees/delegated",
                firstMessage: "delegated prompt",
                lastModified: Date.now(),
                messageCount: 1,
              },
            ],
            total: 1,
          }),
          listCodexSessions: async () => ({ sessions: [], total: 0 }),
          openSession: async (sessionId: string, cwd: string, mode: string, kind: string) => {
            opened.push([sessionId, cwd, mode, kind]);
            return { roomId: "room_delegated", status: "observing" };
          },
        },
      },
    });

    const container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(<CCRoomView cwd="/repo/main" />);
      await flushMicrotasks();
      await flushMicrotasks();
    });

    const sessionCard = findElements(container, "DIV").find((node) =>
      String(reactPropsOf(node).className ?? "").includes("cursor-pointer"),
    );
    expect(sessionCard).toBeDefined();
    await act(async () => {
      reactPropsOf(sessionCard).onClick();
      await flushMicrotasks();
    });

    const defaultButton = findElements(document.body, "BUTTON").find(
      (node) => childText(reactPropsOf(node).children) === "default",
    );
    expect(defaultButton).toBeDefined();
    await act(async () => {
      reactPropsOf(defaultButton).onClick();
      await flushMicrotasks();
    });

    expect(opened).toEqual([
      ["delegated-session", "/repo/.worktrees/delegated", "default", "claude-code"],
    ]);
    expect(conversationProps).toMatchObject({
      cwd: "/repo/.worktrees/delegated",
      observing: true,
    });
  });

  test("opens each request nonce once with the linked cwd, CLI kind, and preserved mode", async () => {
    ensureMiniDom();
    const opened: Array<[string, string, string]> = [];
    const takeovers: Array<[string, string, string, string]> = [];
    let probeCalls = 0;
    Object.assign(window, {
      codeshell: {
        ccRoom: {
          probe: async () => {
            probeCalls += 1;
            return { available: true };
          },
          codexProbe: async () => {
            probeCalls += 1;
            return { available: true };
          },
          listSessions: async () => ({ sessions: [], total: 0 }),
          listCodexSessions: async () => ({ sessions: [], total: 0 }),
          openLinkedSession: async (sessionId: string, cwd: string, kind: string) => {
            opened.push([sessionId, cwd, kind]);
            return {
              roomId: "room_1_abcdef",
              status: "observing",
              mode: "acceptEdits",
              cwd: "/repo/canonical-worktree",
            };
          },
          takeOverLinkedSession: async (
            roomId: string,
            sessionId: string,
            cwd: string,
            kind: string,
          ) => {
            takeovers.push([roomId, sessionId, cwd, kind]);
            return { roomId, status: "running", mode: "acceptEdits", cwd };
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
    expect(probeCalls).toBe(0);
    expect(opened).toEqual([["thread-1", "/repo/worktree", "codex"]]);
    expect(conversationProps).toMatchObject({
      roomId: "room_1_abcdef",
      cwd: "/repo/canonical-worktree",
      sessionId: "thread-1",
      mode: "acceptEdits",
      cliKind: "codex",
      observing: true,
    });

    await act(async () => {
      await (conversationProps?.onTakeOver as () => Promise<void>)();
      await flushMicrotasks();
    });
    expect(takeovers).toEqual([["room_1_abcdef", "thread-1", "/repo/canonical-worktree", "codex"]]);
    expect(conversationProps).toMatchObject({ observing: false });

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
            return { roomId: "room_1_abcdef", status: "observing", mode: "default", cwd: "/repo" };
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
    const claudeProbe = new Promise<{ available: boolean }>((resolve) => {
      resolveClaude = resolve;
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
            return Promise.resolve({ available: true });
          },
          listSessions: async () => ({ sessions: [], total: 0 }),
          listCodexSessions: async () => ({ sessions: [], total: 0 }),
          openLinkedSession: async (sessionId: string) => {
            opened.push(sessionId);
            return { roomId: "room_codex", status: "observing", mode: "default", cwd: "/repo" };
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
    expect(codexCalls).toBe(0);
  });

  test("opens a linked room without invoking a rejecting CLI probe", async () => {
    ensureMiniDom();
    let openCalls = 0;
    let probeCalls = 0;
    Object.assign(window, {
      codeshell: {
        ccRoom: {
          probe: async () => {
            probeCalls += 1;
            throw new Error("probe failed");
          },
          codexProbe: async () => ({ available: true }),
          listSessions: async () => ({ sessions: [], total: 0 }),
          listCodexSessions: async () => ({ sessions: [], total: 0 }),
          openLinkedSession: async () => {
            openCalls += 1;
            return { roomId: "room_never", status: "observing", mode: "default", cwd: "/repo" };
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

    expect(probeCalls).toBe(0);
    expect(openCalls).toBe(1);
    expect(conversationProps).toMatchObject({
      roomId: "room_never",
      sessionId: "claude-thread",
      observing: true,
    });
  });
});

describe("CCRoomView session list recovery", () => {
  const session = (id: string) => ({
    sessionId: id,
    firstMessage: `prompt-${id}`,
    lastModified: 1,
    messageCount: 1,
  });

  function installRoomApi(overrides: Record<string, unknown>) {
    ensureMiniDom();
    Object.assign(window, {
      codeshell: {
        ccRoom: {
          probe: async () => ({ available: true }),
          codexProbe: async () => ({ available: true }),
          listSessions: async () => ({ sessions: [session("first")], total: 1 }),
          listCodexSessions: async () => ({ sessions: [], total: 0 }),
          ...overrides,
        },
      },
    });
  }

  async function mount(cwd: string | null = "/repo") {
    const container = document.createElement("div");
    root = createRoot(container);
    await render(cwd);
    return container;
  }

  async function render(cwd: string | null) {
    await act(async () => {
      root?.render(<CCRoomView cwd={cwd} />);
      await flushMicrotasks();
      await flushMicrotasks();
    });
  }

  function button(container: unknown, label: string) {
    return findElements(container, "BUTTON").find((node) =>
      childText(reactPropsOf(node).children).startsWith(label),
    );
  }

  async function click(node: unknown) {
    expect(node).toBeDefined();
    await act(async () => {
      reactPropsOf(node).onClick();
      await flushMicrotasks();
      await flushMicrotasks();
    });
  }

  test("a failed load-more stays retryable and full-list refresh follows a successful retry", async () => {
    const listCalls: boolean[] = [];
    installRoomApi({
      listSessions: async (_cwd: string, all: boolean) => {
        listCalls.push(all);
        if (listCalls.length === 2) throw new Error("temporary read failure");
        return {
          sessions: all ? [session("first"), session("older")] : [session("first")],
          total: 2,
        };
      },
    });
    const container = await mount();
    await click(button(container, "加载更多"));
    expect(button(container, "加载更多")).toBeDefined();
    const error = findElements(container, "P").find((node) => reactPropsOf(node).role === "alert");
    expect(childText(reactPropsOf(error).children)).toContain("temporary read failure");

    await click(button(container, "加载更多"));
    expect(button(container, "加载更多")).toBeUndefined();
    const refresh = findElements(container, "BUTTON").find(
      (node) => reactPropsOf(node)["aria-label"] === "刷新会话",
    );
    await click(refresh);
    expect(listCalls).toEqual([false, true, true, true]);
  });

  test("switching projects clears the old list and expansion while the new list is pending", async () => {
    let resolveNext!: (value: { sessions: ReturnType<typeof session>[]; total: number }) => void;
    const next = new Promise<{ sessions: ReturnType<typeof session>[]; total: number }>(
      (resolve) => {
        resolveNext = resolve;
      },
    );
    const requests: Array<[string, boolean]> = [];
    installRoomApi({
      listSessions: async (cwd: string, all: boolean) => {
        requests.push([cwd, all]);
        if (cwd === "/next") return next;
        return {
          sessions: all ? [session("first"), session("older")] : [session("first")],
          total: 2,
        };
      },
    });
    const container = await mount();
    await click(button(container, "加载更多"));
    await render("/next");
    expect(
      findElements(container, "DIV").some(
        (node) => childText(reactPropsOf(node).children) === "prompt-first",
      ),
    ).toBe(false);
    await act(async () => {
      resolveNext({ sessions: [session("next")], total: 2 });
      await flushMicrotasks();
    });
    expect(button(container, "加载更多")).toBeDefined();
    expect(requests.at(-1)).toEqual(["/next", false]);
  });

  test("focus refresh cannot replace an in-flight load-more with the bounded list", async () => {
    let resolveMore!: (value: { sessions: ReturnType<typeof session>[]; total: number }) => void;
    const calls: boolean[] = [];
    installRoomApi({
      listSessions: (_cwd: string, all: boolean) => {
        calls.push(all);
        return all
          ? new Promise((resolve) => {
              resolveMore = resolve;
            })
          : Promise.resolve({ sessions: [session("first")], total: 2 });
      },
    });
    const container = await mount();
    await click(button(container, "加载更多"));
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      await flushMicrotasks();
    });
    expect(calls).toEqual([false, true]);
    await act(async () => {
      resolveMore({ sessions: [session("first"), session("older")], total: 2 });
      await flushMicrotasks();
    });
    expect(button(container, "加载更多")).toBeUndefined();
  });

  test("late results from a closed project cannot restore its sessions", async () => {
    let resolveList!: (value: { sessions: ReturnType<typeof session>[]; total: number }) => void;
    installRoomApi({
      listSessions: () =>
        new Promise((resolve) => {
          resolveList = resolve;
        }),
    });
    const container = await mount();
    await render(null);
    await act(async () => {
      resolveList({ sessions: [session("stale")], total: 1 });
      await flushMicrotasks();
    });
    expect(
      findElements(container, "DIV").some(
        (node) => childText(reactPropsOf(node).children) === "prompt-stale",
      ),
    ).toBe(false);
    expect(button(container, "加载更多")).toBeUndefined();
  });

  test("opening is single-flight and can retry after failure", async () => {
    let rejectOpen!: (error: Error) => void;
    let calls = 0;
    installRoomApi({
      openSession: () => {
        calls += 1;
        return calls === 1
          ? new Promise((_resolve, reject) => {
              rejectOpen = reject;
            })
          : Promise.resolve({ roomId: "room-retry", status: "observing" });
      },
    });
    const container = await mount();
    await click(button(container, "新开 session"));
    const open = button(container, "default");
    await act(async () => {
      reactPropsOf(open).onClick();
      reactPropsOf(open).onClick();
      await flushMicrotasks();
    });
    expect(calls).toBe(1);
    expect(reactPropsOf(button(container, "default")).disabled).toBe(true);
    await act(async () => {
      rejectOpen(new Error("unable to start CLI"));
      await flushMicrotasks();
    });
    expect(reactPropsOf(button(container, "default")).disabled).toBe(false);
    await click(button(container, "default"));
    expect(calls).toBe(2);
    expect(conversationProps).toMatchObject({ roomId: "room-retry" });
  });

  test("a delayed open cannot navigate away from a newer project", async () => {
    let resolveOpen!: (value: { roomId: string; status: string }) => void;
    installRoomApi({
      openSession: () =>
        new Promise((resolve) => {
          resolveOpen = resolve;
        }),
    });
    const container = await mount();
    await click(button(container, "新开 session"));
    await click(button(container, "default"));
    await render("/next");
    await act(async () => {
      resolveOpen({ roomId: "stale-room", status: "running" });
      await flushMicrotasks();
    });
    expect(conversationProps).toBeNull();
    expect(button(container, "default")).toBeUndefined();
  });

  test("a CLI that exits during startup remains retryable instead of opening a running conversation", async () => {
    let calls = 0;
    installRoomApi({
      openSession: async () => ({
        roomId: "startup-room",
        status: ++calls === 1 ? "missing" : "running",
      }),
    });
    const container = await mount();
    await click(button(container, "新开 session"));
    await click(button(container, "default"));
    expect(conversationProps).toBeNull();
    expect(reactPropsOf(button(container, "default")).disabled).toBe(false);
    await click(button(container, "default"));
    expect(conversationProps).toMatchObject({ roomId: "startup-room", observing: false });
  });
});
