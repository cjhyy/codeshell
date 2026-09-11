import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { PetApi, PetChatEvent, PetCommand } from "../../preload/pet-api";
import { ensureMiniDom, flushMicrotasks } from "../test-utils/renderHook";
import { INITIAL_STATE } from "../types";
import { PetChatHost } from "./PetChatHost";
import { PetDesktopWindow } from "./PetDesktopWindow";
import { PET_CHAT_BUCKET, PetStateProvider, usePetState } from "./PetStateProvider";

function elements(node: Node, tagName: string): HTMLElement[] {
  return [
    ...((node as HTMLElement).tagName === tagName ? [node as HTMLElement] : []),
    ...Array.from(node.childNodes).flatMap((child) => elements(child, tagName)),
  ];
}

function propsOf(node: HTMLElement): Record<string, any> {
  const key = Object.keys(node).find((name) => name.startsWith("__reactProps$"));
  return key ? (node as unknown as Record<string, any>)[key] : {};
}

function renderedText(node: Node): string {
  if (node.nodeType === 3) return (node as Text).data;
  return node.childNodes.length
    ? Array.from(node.childNodes).map(renderedText).join("")
    : (node.textContent ?? "");
}

function enterEvent(isComposing = false, keyCode = 13, shiftKey = false) {
  return {
    key: "Enter",
    keyCode,
    shiftKey,
    nativeEvent: { isComposing },
    defaultPrevented: false,
    preventDefault() {
      this.defaultPrevented = true;
    },
  };
}

describe("Mimi chat interactions", () => {
  let container: HTMLElement;
  let root: Root;
  let originalCodeshell: unknown;
  let originalScrollIntoView: typeof HTMLElement.prototype.scrollIntoView;
  let api: PetApi;
  let latest: ReturnType<typeof usePetState>;
  let chatListener: ((event: PetChatEvent) => void) | undefined;
  let sent: Array<Extract<PetCommand, { type: "chat" }>>;

  beforeEach(() => {
    ensureMiniDom();
    originalCodeshell = window.codeshell;
    originalScrollIntoView = HTMLElement.prototype.scrollIntoView;
    HTMLElement.prototype.scrollIntoView = () => {};
    sent = [];
    api = {
      getSnapshot: async () => ({
        version: 1,
        generation: 0,
        workerState: "active",
        sessions: [],
        pending: [],
        observedAt: 1,
      }),
      onProjectionEvent: () => () => {},
      openSession: async () => ({ status: "not-found" }),
      dispatch: async (command) => {
        if (command.type === "get_global_status") {
          return {
            ok: true,
            type: "global_status",
            version: 1,
            generation: 0,
            observedAt: 1,
            workerState: "active",
            petSessionId: "pet-input-test",
            runningCount: 0,
            queuedCount: 0,
            pendingCount: 0,
            sessions: [],
          };
        }
        if (command.type === "chat") {
          sent.push(command);
          return { ok: true, type: "chat", petSessionId: "pet-input-test", result: null };
        }
        return { ok: false, code: "invalid-command" };
      },
      onChatEvent: (listener) => {
        chatListener = listener;
        return () => {
          chatListener = undefined;
        };
      },
      getAttentionSnapshot: async () => ({ surfaceablePendingCount: 0 }),
      onAttentionEvent: () => () => {},
      setActiveSession: async () => ({ ok: true }),
      markAttentionReceipt: async () => ({ ok: true }),
      setWidgetSurface: async () => ({ ok: true }),
    };
    (window as unknown as Record<string, unknown>).codeshell = { pet: api };
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    document.body.removeChild(container);
    (window as unknown as Record<string, unknown>).codeshell = originalCodeshell;
    if (originalScrollIntoView) HTMLElement.prototype.scrollIntoView = originalScrollIntoView;
    else Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
  });

  async function mount(surface: "host" | "widget", onOpenSession = (_request: unknown) => {}) {
    function Consumer() {
      latest = usePetState();
      return surface === "host" ? (
        <PetChatHost
          defaultProjectPath={null}
          defaultModelKey={null}
          modelOptions={[]}
          onOpenSession={onOpenSession}
        />
      ) : (
        <PetDesktopWindow />
      );
    }
    await act(async () => {
      root.render(
        <PetStateProvider api={api}>
          <Consumer />
        </PetStateProvider>,
      );
      await flushMicrotasks();
    });
    expect(latest.petSessionId).toBe("pet-input-test");
    if (surface === "widget") {
      const toggle = elements(container, "BUTTON").find(
        (node) => node.getAttribute("data-pet-action") === "chat",
      )!;
      await act(async () => propsOf(toggle).onKeyDown(enterEvent()));
    }
  }

  test("keeps Chinese candidate confirmation in the main draft and submits the confirmed text once", async () => {
    await mount("host");
    const input = elements(container, "TEXTAREA")[0]!;
    await act(async () => propsOf(input).onChange({ target: { value: "中文输入" } }));
    for (const event of [enterEvent(true), enterEvent(false, 229), enterEvent(false, 13, true)]) {
      await act(async () => propsOf(input).onKeyDown(event));
      expect(sent).toHaveLength(0);
      expect(propsOf(input).value).toBe("中文输入");
      expect(event.defaultPrevented).toBe(false);
    }
    const submit = enterEvent();
    await act(async () => {
      propsOf(input).onKeyDown(submit);
      await flushMicrotasks();
    });
    expect(submit.defaultPrevented).toBe(true);
    expect(sent.map((command) => command.message)).toEqual(["中文输入"]);
    expect(propsOf(input).value).toBe("");
    expect(renderedText(container)).toContain("中文输入");
  });

  test("prevents the widget form from submitting Chinese candidate confirmation", async () => {
    await mount("widget");
    const input = elements(container, "INPUT")[0]!;
    const form = elements(container, "FORM")[0]!;
    await act(async () => propsOf(input).onChange({ target: { value: "中文输入" } }));
    const pressEnter = async (event: ReturnType<typeof enterEvent>) => {
      await act(async () => {
        propsOf(input).onKeyDown(event);
        // Browser forms submit on uncancelled Enter; MiniDOM has no default actions.
        if (!event.defaultPrevented) propsOf(form).onSubmit({ preventDefault() {} });
        await flushMicrotasks();
      });
    };
    for (const event of [enterEvent(true), enterEvent(false, 229)]) {
      await pressEnter(event);
      expect(event.defaultPrevented).toBe(true);
      expect(sent).toHaveLength(0);
      expect(propsOf(input).value).toBe("中文输入");
    }
    await pressEnter(enterEvent());
    expect(sent.map((command) => command.message)).toEqual(["中文输入"]);
    expect(propsOf(input).value).toBe("");
    expect(renderedText(container)).toContain("中文输入");
  });

  test("keeps the conversation and working Session directly visible after compaction", async () => {
    const opened: unknown[] = [];
    await mount("host", (request) => {
      opened.push(request);
    });
    await act(async () => {
      latest.chatDispatch({
        type: "hydrate",
        bucket: PET_CHAT_BUCKET,
        state: {
          ...INITIAL_STATE,
          messages: [
            { kind: "user", id: "u1", text: "帮我处理这个任务", clientMessageId: "task-input" },
            { kind: "assistant", id: "a1", text: "正在安排执行。", done: true },
            {
              kind: "context_boundary",
              id: "ctx1",
              strategy: "summary",
              before: 12000,
              after: 1500,
            },
          ],
        },
      });
      chatListener?.({
        kind: "delegation-started",
        originClientMessageId: "task-input",
        delegations: [
          {
            sessionId: "new-work-session",
            task: "处理任务",
            workspacePath: "/work/app",
            reusedSession: false,
          },
        ],
      });
      await flushMicrotasks();
    });
    expect(renderedText(container)).toContain("帮我处理这个任务");
    expect(renderedText(container)).toContain("正在安排执行。");
    expect(elements(container, "DETAILS").filter((node) => !propsOf(node).open)).toHaveLength(0);
    const openButton = elements(container, "BUTTON").find((node) =>
      renderedText(node).includes("打开 Session"),
    )!;
    expect(openButton).toBeDefined();
    expect(propsOf(openButton).disabled).toBeFalsy();
    await act(async () => propsOf(openButton).onClick());
    expect(opened).toEqual([
      { agentSessionId: "new-work-session", snapshotVersion: 1, generation: 0 },
    ]);
  });

  test("keeps the reader's scroll position and offers a return to the latest reply", async () => {
    let forcedScrolls = 0;
    HTMLElement.prototype.scrollIntoView = () => {
      forcedScrolls += 1;
    };
    await mount("host");
    const hydrate = (text: string) =>
      latest.chatDispatch({
        type: "hydrate",
        bucket: PET_CHAT_BUCKET,
        state: {
          ...INITIAL_STATE,
          messages: [
            { kind: "user", id: "u1", text: "old question" },
            { kind: "assistant", id: "a1", text, done: false },
          ],
        },
      });
    await act(async () => hydrate("first paragraph"));
    const scroller = elements(container, "DIV").find(
      (node) => typeof propsOf(node).onScroll === "function",
    )!;
    Object.defineProperties(scroller, {
      scrollTop: { value: 100, writable: true, configurable: true },
      scrollHeight: { value: 2000, writable: true, configurable: true },
      clientHeight: { value: 400, writable: true, configurable: true },
    });
    await act(async () => propsOf(scroller).onScroll({ currentTarget: scroller }));
    const before = forcedScrolls;
    await act(async () => hydrate("first paragraph and additional streamed text"));
    expect(forcedScrolls).toBe(before);
    const latestButton = elements(container, "BUTTON").find(
      (node) => renderedText(node) === "回到最新消息",
    )!;
    expect(latestButton).toBeDefined();
    await act(async () => propsOf(latestButton).onClick());
    expect(forcedScrolls).toBe(before + 1);
    await act(async () => hydrate("another paragraph"));
    expect(forcedScrolls).toBe(before + 2);
  });

  test("shows a failed run and can restore its input without erasing a newer draft", async () => {
    const originalDispatch = api.dispatch;
    api.dispatch = async (command) =>
      command.type !== "chat"
        ? originalDispatch(command)
        : {
            ok: true,
            type: "chat",
            petSessionId: "pet-input-test",
            result: {
              reason: "prompt_too_long",
              text: "Prompt is too long. Start a new conversation.",
            },
          };
    await mount("host");
    const input = elements(container, "TEXTAREA")[0]!;
    await act(async () => propsOf(input).onChange({ target: { value: "My request" } }));
    await act(async () => {
      propsOf(input).onKeyDown(enterEvent());
      await flushMicrotasks();
    });
    expect(renderedText(container)).toContain("Prompt is too long");
    expect(elements(container, "BUTTON").some((node) => renderedText(node) === "重新发送")).toBe(
      false,
    );
    await act(async () => propsOf(input).onChange({ target: { value: "New context" } }));
    const restore = elements(container, "BUTTON").find(
      (node) => renderedText(node) === "恢复到输入框",
    )!;
    await act(async () => propsOf(restore).onClick());
    expect(propsOf(input).value).toBe("New context\n\nMy request");
  });

  test("retains dropped files and failed send intents across settings remounts", async () => {
    const originalDispatch = api.dispatch;
    let fail = true;
    api.dispatch = async (command) => {
      if (command.type !== "chat") return originalDispatch(command);
      sent.push(command);
      return fail
        ? { ok: false, code: "worker-error", message: "Connection lost" }
        : {
            ok: true,
            type: "chat",
            petSessionId: "pet-input-test",
            result: { reason: "completed" },
          };
    };
    await mount("host");
    const input = elements(container, "TEXTAREA")[0]!;
    await act(async () => propsOf(input).onChange({ target: { value: "Read the attached spec" } }));
    const section = elements(container, "SECTION").find(
      (node) => node.getAttribute("data-pet-manager-chat") === "true",
    )!;
    await act(async () =>
      propsOf(section).onDrop({
        preventDefault() {},
        dataTransfer: { getData: () => "/tmp/spec.pdf", files: [] },
      }),
    );
    await mount("host");
    expect(renderedText(container)).toContain("spec.pdf");
    const remountedInput = elements(container, "TEXTAREA")[0]!;
    expect(propsOf(remountedInput).value).toBe("Read the attached spec");
    await act(async () => {
      propsOf(remountedInput).onKeyDown(enterEvent());
      await flushMicrotasks();
    });
    await mount("host");
    expect(renderedText(container)).toContain("Connection lost");
    fail = false;
    const retry = elements(container, "BUTTON").find((node) => renderedText(node) === "重新发送")!;
    await act(async () => {
      propsOf(retry).onClick();
      await flushMicrotasks();
    });
    expect(sent).toHaveLength(2);
    expect(sent[1]).toEqual(sent[0]);
    expect(latest.chatState.messages.filter((message) => message.kind === "user")).toHaveLength(1);
    expect(renderedText(container)).not.toContain("Connection lost");
  });

  test("keeps sends in flight across navigation and stops only the captured reply", async () => {
    const originalDispatch = api.dispatch;
    let resolveChat!: (result: any) => void;
    const stops: unknown[] = [];
    api.dispatch = async (command) => {
      if (command.type === "stop_chat") {
        stops.push(command);
        return { ok: true, type: "chat_stopped", stopped: true };
      }
      if (command.type !== "chat") return originalDispatch(command);
      sent.push(command);
      return new Promise((resolve) => {
        resolveChat = resolve;
      });
    };
    await mount("host");
    const input = elements(container, "TEXTAREA")[0]!;
    await act(async () => propsOf(input).onChange({ target: { value: "Do work" } }));
    await act(async () => {
      propsOf(input).onKeyDown(enterEvent());
      await flushMicrotasks();
    });
    await mount("host");
    expect(latest.chatBusy).toBe(true);
    const stop = elements(container, "BUTTON").find((node) => renderedText(node) === "停止回复")!;
    await act(async () => {
      propsOf(stop).onClick();
      await flushMicrotasks();
    });
    expect(stops).toEqual([{ type: "stop_chat", clientMessageId: sent[0]!.clientMessageId }]);
    expect(latest.chatBusy).toBe(false);
    await act(async () => {
      resolveChat({
        ok: true,
        type: "chat",
        petSessionId: "pet-input-test",
        result: { reason: "aborted_streaming" },
      });
      await flushMicrotasks();
    });
    expect(renderedText(container)).toContain("本轮回复已停止");
  });

  test("keeps live activity after an unknown send outcome and ignores unrelated terminals", async () => {
    let streamListener: ((envelope: any) => void) | undefined;
    (window.codeshell as any).onStreamEvent = (listener: typeof streamListener) => {
      streamListener = listener;
      return () => {
        streamListener = undefined;
      };
    };
    const originalDispatch = api.dispatch;
    let resolveSend!: (result: any) => void;
    api.dispatch = async (command) =>
      command.type === "chat"
        ? new Promise((resolve) => {
            resolveSend = resolve;
          })
        : originalDispatch(command);
    await mount("host");
    let sending!: Promise<void>;
    await act(async () => {
      sending = latest.submitChat({
        clientMessageId: "active-input",
        message: "work",
        draft: "work",
        paths: [],
      });
      await flushMicrotasks();
      streamListener?.({
        sessionId: "pet-input-test",
        event: {
          type: "session_started",
          sessionId: "pet-input-test",
          promptTokens: 0,
          runId: "active-run",
          clientMessageId: "active-input",
        },
      });
      streamListener?.({
        sessionId: "pet-input-test",
        event: {
          type: "stream_request_start",
          turnNumber: 1,
          runId: "active-run",
          clientMessageId: "active-input",
        },
      });
    });
    await act(async () => {
      resolveSend({ ok: false, code: "worker-error", message: "Response wait expired" });
      await sending;
    });
    expect(latest.chatBusy).toBe(true);
    await act(async () => {
      streamListener?.({
        sessionId: "pet-input-test",
        event: {
          type: "turn_complete",
          reason: "completed",
          runId: "old-run",
          clientMessageId: "old-input",
        },
      });
      streamListener?.({
        sessionId: "pet-input-test",
        event: { type: "error", error: "child failed", agentId: "child", runId: "child-run" },
      });
    });
    expect(latest.chatBusy).toBe(true);
    await act(async () =>
      streamListener?.({
        sessionId: "pet-input-test",
        event: {
          type: "turn_complete",
          reason: "completed",
          runId: "active-run",
          clientMessageId: "active-input",
        },
      }),
    );
    expect(latest.chatBusy).toBe(false);
  });
});
