import { afterEach, describe, expect, mock, test } from "bun:test";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ensureMiniDom, flushMicrotasks } from "../test-utils/renderHook";

// `bun test` shares one module registry across files, and CCRoomView's suite
// stubs "./CCConversationView". Re-register the real module through a distinct
// specifier so these tests exercise the component no matter the file order.
const realConversationView = await import("./CCConversationView?real");
mock.module("./CCConversationView", () => realConversationView);
const { CCConversationView } = realConversationView;

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

  test("sends a dropped PDF as an exact local path reference", async () => {
    ensureMiniDom();
    const sentMessages: string[] = [];
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
        send: async (_roomId: string, text: string) => {
          sentMessages.push(text);
          return true;
        },
        respondApproval: async () => undefined,
      },
    };

    const container = document.createElement("div");
    root = createRoot(container);
    await act(async () => {
      root?.render(
        <CCConversationView
          roomId="room-files"
          cwd="/repo"
          sessionId="thread-files"
          mode="default"
          onBack={() => undefined}
        />,
      );
      await flushMicrotasks();
    });

    const droppedFile = {
      name: "quarterly report.pdf",
      path: "/repo/My PDFs/quarterly report.pdf",
    } as File;
    await act(async () => {
      reactPropsOf(findElementByProp(container, "onDrop")).onDrop({
        preventDefault() {},
        dataTransfer: {
          files: [droppedFile],
          getData: () => "",
        },
      });
      await flushMicrotasks();
    });

    expect(findElementByProp(container, "data-cc-room-path-attachments")).toBeDefined();
    await act(async () => {
      reactPropsOf(findElementByProp(container, "data-cc-room-composer")).onKeyDown({
        key: "Enter",
        shiftKey: false,
        preventDefault() {},
      });
      await flushMicrotasks();
      await flushMicrotasks();
    });

    expect(sentMessages).toEqual([
      '本地文件路径（由你拖入）:\n- "/repo/My PDFs/quarterly report.pdf"',
    ]);
  });
});

function renderedText(node: any): string {
  if (node.nodeType === 3) return node.nodeValue ?? node.textContent ?? "";
  return node.childNodes?.length
    ? node.childNodes.map(renderedText).join("")
    : (node.textContent ?? "");
}

describe("CCConversationView existing external subtask records", () => {
  async function renderRoom(messages: unknown[]) {
    ensureMiniDom();
    let receive: (event: { roomId: string; msg: unknown }) => void = () => undefined;
    let nativeReads = 0;
    const off = () => undefined;
    (window as unknown as { codeshell: Record<string, unknown> }).codeshell = {
      getSessionTranscript: async () => {
        nativeReads += 1;
        throw new Error("External IDs must not query native storage");
      },
      listDiskSessions: async () => {
        nativeReads += 1;
        throw new Error("External rooms must not query native storage");
      },
      ccRoom: {
        onApprovalRequest: () => off,
        onApprovalResolved: () => off,
        onRoomMessage: (listener: typeof receive) => {
          receive = listener;
          return off;
        },
        subscribeTranscript: async () => ({ messages, roomCursor: 0 }),
        unsubscribeTranscript: async () => undefined,
        roomHistory: async () => [],
        send: async () => undefined,
        respondApproval: async () => undefined,
      },
    };
    const container = document.createElement("div");
    root = createRoot(container);
    await act(async () => {
      root!.render(
        <CCConversationView
          roomId="external-room"
          sessionId="external-session"
          cwd="/external-repo"
          mode="default"
          onBack={() => undefined}
        />,
      );
      await flushMicrotasks();
    });
    return {
      container,
      nativeReads: () => nativeReads,
      emit: async (msg: unknown) => {
        await act(async () => {
          receive({ roomId: "external-room", msg });
          await flushMicrotasks();
        });
      },
      openSubtask: async () => {
        const button = findElementByProp(container, "data-cc-subagent");
        expect(button).toBeDefined();
        await act(async () => {
          reactPropsOf(button).onClick();
          await flushMicrotasks();
        });
      },
    };
  }

  test("a real normalized history Agent tool opens its captured request without native-store fallback", async () => {
    const view = await renderRoom([
      {
        role: "assistant",
        text: "",
        tools: [
          {
            name: "Agent",
            summary: "",
            args: {
              description: "Inspect external document",
              prompt: "Verify the complete permission trail",
              subagent_type: "general-purpose",
            },
          },
        ],
      },
    ]);
    await view.openSubtask();
    expect(renderedText(view.container)).toContain("Verify the complete permission trail");
    expect(renderedText(view.container)).toContain("内部对话尚未收录");
    expect(view.nativeReads()).toBe(0);
  });

  test("real room tool events create an entry and its open detail receives the matching result", async () => {
    const view = await renderRoom([]);
    await view.emit({
      seq: 1,
      from: "agent",
      type: "tool",
      toolId: "delegate-call",
      tool: "Task",
      args: { description: "Read external document", prompt: "Check external login" },
    });
    await view.openSubtask();
    expect(renderedText(view.container)).toContain("Check external login");
    await view.emit({
      seq: 2,
      from: "agent",
      type: "tool_result",
      toolId: "delegate-call",
      summary: "Permission denied by external browser",
      isError: true,
    });
    expect(renderedText(view.container)).toContain("Permission denied by external browser");
    await view.emit({ seq: 3, from: "agent", type: "text", text: "Unrelated parent response" });
    expect(renderedText(view.container)).not.toContain("Unrelated parent response");
    expect(view.nativeReads()).toBe(0);
  });
});

describe("CCConversationView asynchronous recovery", () => {
  function elements(node: any, tag: string): any[] {
    return [
      ...(node.tagName === tag ? [node] : []),
      ...(node.childNodes ?? []).flatMap((child: any) => elements(child, tag)),
    ];
  }

  function installRoomApi(overrides: Record<string, unknown> = {}) {
    ensureMiniDom();
    const receive: Record<string, (...args: any[]) => void> = {};
    const off = () => undefined;
    Object.assign(window, {
      codeshell: {
        ccRoom: {
          onApprovalRequest: (cb: (...args: any[]) => void) => {
            receive.approval = cb;
            return off;
          },
          onApprovalResolved: (cb: (...args: any[]) => void) => {
            receive.resolved = cb;
            return off;
          },
          onRoomMessage: (cb: (...args: any[]) => void) => {
            receive.message = cb;
            return off;
          },
          subscribeTranscript: async () => ({ messages: [], roomCursor: 0 }),
          unsubscribeTranscript: async () => undefined,
          roomHistory: async () => [],
          readHistory: async () => ({ messages: [] }),
          readCodexHistory: async () => ({ messages: [] }),
          send: async () => true,
          respondApproval: async () => true,
          ...overrides,
        },
      },
    });
    return receive;
  }

  async function render(props: Partial<React.ComponentProps<typeof CCConversationView>> = {}) {
    await act(async () => {
      root?.render(
        <CCConversationView
          roomId="room"
          cwd="/repo"
          sessionId="session"
          mode="default"
          onBack={() => undefined}
          {...props}
        />,
      );
      await flushMicrotasks();
      await flushMicrotasks();
    });
  }

  async function mount(props: Partial<React.ComponentProps<typeof CCConversationView>> = {}) {
    const container = document.createElement("div");
    root = createRoot(container);
    await render(props);
    return container;
  }

  async function editDraft(container: unknown, value: string) {
    await act(async () => {
      reactPropsOf(findElementByProp(container, "data-cc-room-composer")).onChange({
        target: { value },
      });
      await flushMicrotasks();
    });
  }

  const enter = { key: "Enter", shiftKey: false, preventDefault() {} };

  test("re-entering a plain room replaces its full history instead of duplicating messages", async () => {
    installRoomApi({
      roomHistory: async () => [{ seq: 1, from: "user", type: "text", text: "unique-backlog" }],
    });
    const container = await mount({ sessionId: "" });
    await render({ sessionId: "", active: false });
    await render({ sessionId: "", active: true });
    expect(renderedText(container).match(/unique-backlog/g)).toHaveLength(1);
  });

  test("a failed subscription and fallback expose retry while keeping live messages usable", async () => {
    let recovered = false;
    const receive = installRoomApi({
      subscribeTranscript: async () => {
        if (!recovered) throw new Error("subscription unavailable");
        return { messages: [{ role: "user", text: "recovered-history" }], roomCursor: 1 };
      },
      readHistory: async () => {
        throw new Error("disk unavailable");
      },
      unsubscribeTranscript: async () => {
        throw new Error("window disconnected");
      },
    });
    const container = await mount();
    expect(renderedText(container)).toContain("disk unavailable");
    await act(async () => {
      receive.message({
        roomId: "room",
        msg: { seq: 1, from: "user", type: "text", text: "live-message" },
      });
      await flushMicrotasks();
    });
    expect(renderedText(container)).toContain("live-message");
    recovered = true;
    const retry = elements(container, "BUTTON").find((node) => renderedText(node) === "重新读取");
    expect(retry).toBeDefined();
    await act(async () => {
      reactPropsOf(retry).onClick();
      await flushMicrotasks();
      await flushMicrotasks();
    });
    expect(renderedText(container)).toContain("recovered-history");
    expect(renderedText(container)).not.toContain("disk unavailable");
  });

  test("rapid sends share one request and its acknowledgement preserves the next draft", async () => {
    let resolveSend!: (value: boolean) => void;
    let sends = 0;
    installRoomApi({
      send: () => {
        sends += 1;
        return new Promise((resolve) => {
          resolveSend = resolve;
        });
      },
    });
    const container = await mount();
    await editDraft(container, "first message");
    const composer = findElementByProp(container, "data-cc-room-composer");
    await act(async () => {
      reactPropsOf(composer).onKeyDown(enter);
      reactPropsOf(composer).onKeyDown(enter);
      await flushMicrotasks();
    });
    expect(sends).toBe(1);
    await editDraft(container, "next draft");
    await act(async () => {
      resolveSend(true);
      await flushMicrotasks();
    });
    expect(reactPropsOf(composer).value).toBe("next draft");
  });

  test("the Enter used to confirm an IME composition does not send", async () => {
    let sends = 0;
    installRoomApi({
      send: async () => {
        sends += 1;
        return true;
      },
    });
    const container = await mount();
    await editDraft(container, "中文草稿");
    await act(async () => {
      const keyDown = reactPropsOf(findElementByProp(container, "data-cc-room-composer")).onKeyDown;
      keyDown({ ...enter, nativeEvent: { isComposing: true } });
      keyDown({ ...enter, keyCode: 229 });
      await flushMicrotasks();
    });
    expect(sends).toBe(0);
  });

  test("rapid takeover clicks start one operation and allow retry after rejection", async () => {
    let rejectTakeover!: (error: Error) => void;
    let attempts = 0;
    installRoomApi();
    const container = await mount({
      observing: true,
      onTakeOver: () => {
        attempts += 1;
        return new Promise((_resolve, reject) => {
          rejectTakeover = reject;
        });
      },
    });
    const button = findElementByProp(container, "data-cc-room-takeover");
    await act(async () => {
      reactPropsOf(button).onClick();
      reactPropsOf(button).onClick();
      await flushMicrotasks();
    });
    expect(attempts).toBe(1);
    expect(reactPropsOf(button).disabled).toBe(true);
    await act(async () => {
      rejectTakeover(new Error("CLI unavailable"));
      await flushMicrotasks();
    });
    expect(reactPropsOf(button).disabled).toBe(false);
  });

  test("a send that completes after switching rooms does not clear the new room draft", async () => {
    let resolveSend!: (value: boolean) => void;
    installRoomApi({
      send: () =>
        new Promise((resolve) => {
          resolveSend = resolve;
        }),
    });
    const container = await mount();
    await editDraft(container, "old-room draft");
    await act(async () => {
      reactPropsOf(findElementByProp(container, "data-cc-room-composer")).onKeyDown(enter);
      await flushMicrotasks();
    });
    await render({ roomId: "next-room", sessionId: "next-session" });
    expect(reactPropsOf(findElementByProp(container, "data-cc-room-composer")).value).toBe("");
    await editDraft(container, "new-room draft");
    await act(async () => {
      resolveSend(true);
      await flushMicrotasks();
    });
    expect(reactPropsOf(findElementByProp(container, "data-cc-room-composer")).value).toBe(
      "new-room draft",
    );
  });

  test("approval failures retain the card for retry and other rooms cannot clear it", async () => {
    let rejectResponse!: (error: Error) => void;
    let responses = 0;
    const receive = installRoomApi({
      respondApproval: () => {
        responses += 1;
        return responses === 1
          ? new Promise((_resolve, reject) => {
              rejectResponse = reject;
            })
          : Promise.resolve(true);
      },
    });
    const container = await mount();
    await act(async () => {
      receive.approval({
        roomId: "room",
        requestId: "same-request",
        toolName: "Bash",
        input: { command: "pwd" },
      });
      await flushMicrotasks();
      receive.resolved({ roomId: "another-room", requestId: "same-request" });
      await flushMicrotasks();
    });
    const card = findElementByProp(container, "data-cc-room-approval");
    expect(card).toBeDefined();
    const allow = elements(card, "BUTTON").find((node) => renderedText(node) === "允许");
    await act(async () => {
      reactPropsOf(allow).onClick();
      reactPropsOf(allow).onClick();
      await flushMicrotasks();
    });
    expect(responses).toBe(1);
    expect(reactPropsOf(allow).disabled).toBe(true);
    await act(async () => {
      rejectResponse(new Error("IPC failed"));
      await flushMicrotasks();
    });
    expect(findElementByProp(container, "data-cc-room-approval")).toBeDefined();
    expect(reactPropsOf(allow).disabled).toBe(false);
    await act(async () => {
      reactPropsOf(allow).onClick();
      await flushMicrotasks();
    });
    expect(responses).toBe(2);
    expect(findElementByProp(container, "data-cc-room-approval")).toBeUndefined();
  });
});
