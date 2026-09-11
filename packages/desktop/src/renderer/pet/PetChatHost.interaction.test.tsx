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
});
