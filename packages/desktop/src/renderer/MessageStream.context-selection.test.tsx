import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { RawTranscriptEvent, SummaryForkSessionResult } from "../preload/types";
import { ensureMiniDom, flushMicrotasks } from "./test-utils/renderHook";
import { MessageStream } from "./MessageStream";
import type { Message } from "./types";

function reactPropsOf(node: unknown): Record<string, any> {
  const current = node as Record<string, any>;
  const key = Object.keys(current).find((name) => name.startsWith("__reactProps$"));
  return key ? current[key] : {};
}

function findElements(node: unknown, tagName: string): any[] {
  const current = node as { tagName?: string; childNodes?: unknown[] };
  return [
    ...(current.tagName === tagName ? [current] : []),
    ...(current.childNodes ?? []).flatMap((child) => findElements(child, tagName)),
  ];
}

function contextTurnButtons(container: unknown): any[] {
  return findElements(container, "BUTTON").filter(
    (button) => reactPropsOf(button)["data-context-turn-index"] !== undefined,
  );
}

function mergeButton(container: unknown): any {
  return findElements(container, "BUTTON").find(
    (button) => reactPropsOf(button)["data-context-action"] === "merge",
  );
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function renderedText(node: unknown): string {
  const current = node as {
    childNodes?: unknown[];
    data?: string;
    nodeType?: number;
    textContent?: string;
  };
  if (current.nodeType === 3) return current.data ?? current.textContent ?? "";
  const children = Array.from(current.childNodes ?? []);
  if (children.length === 0) return current.textContent ?? "";
  return children.map(renderedText).join("");
}

const rawEvents: RawTranscriptEvent[] = [
  {
    id: "old-user",
    type: "message",
    turnNumber: 0,
    timestamp: 1,
    data: { role: "user", content: "old selection" },
  },
  {
    id: "old-boundary",
    type: "turn_boundary",
    turnNumber: 1,
    timestamp: 2,
    data: {},
  },
];

const summaryResult: SummaryForkSessionResult = {
  sessionId: "packaged-target",
  mode: "summary",
  summary: "packaged context",
  sourceRange: { fromEventId: "old-user", toEventId: "old-boundary" },
  estimatedTokens: 42,
  forkedFrom: {
    sessionId: "old-session",
    mode: "summary",
    sourceEventCount: 2,
    createdAt: 3,
  },
  workspace: { root: "/tmp/project", kind: "main" },
};

const displayMessages: Message[] = [
  { kind: "user", id: "display-user", text: "old selection" },
  { kind: "assistant", id: "display-assistant", text: "answer", done: true },
];

const multiTurnDisplayMessages: Message[] = [
  { kind: "user", id: "display-u1", text: "first" },
  { kind: "assistant", id: "display-a1", text: "first answer", done: true },
  { kind: "user", id: "display-u2", text: "second" },
  { kind: "assistant", id: "display-a2", text: "second answer", done: true },
  { kind: "user", id: "display-u3", text: "third" },
  { kind: "assistant", id: "display-a3", text: "third answer", done: true },
];

describe("MessageStream context selection session boundary", () => {
  let root: Root | null;
  let container: HTMLElement;

  beforeEach(() => {
    ensureMiniDom();
    Object.assign(window, {
      codeshell: {
        getSessionRawEvents: async () => rawEvents,
      },
    });
    container = document.createElement("div") as unknown as HTMLElement;
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root?.unmount();
      await flushMicrotasks();
    });
    root = null;
  });

  test("closes and clears an open selection when engineSessionId changes", async () => {
    const render = async (engineSessionId: string, contextSelectionRequest: number) => {
      await act(async () => {
        root?.render(
          <MessageStream
            messages={displayMessages}
            engineSessionId={engineSessionId}
            liveTurnActive={false}
            onContextPackageCreated={() => undefined}
            contextSelectionRequest={contextSelectionRequest}
          />,
        );
        await flushMicrotasks();
      });
    };

    await render("old-session", 0);
    expect(contextTurnButtons(container)).toHaveLength(0);
    await render("old-session", 1);
    expect(contextTurnButtons(container)).toHaveLength(1);
    await act(async () => {
      reactPropsOf(contextTurnButtons(container)[0]).onClick();
      await flushMicrotasks();
    });
    const selectedTask = findElements(container, "DIV").find(
      (node) => reactPropsOf(node)["data-context-turn-selected"] === "true",
    );
    expect(selectedTask).toBeDefined();
    expect(renderedText(selectedTask)).toContain("old selection");
    expect(renderedText(selectedTask)).toContain("answer");

    await render("new-session", 1);

    expect(contextTurnButtons(container)).toHaveLength(0);
  });

  test("registers a deferred package without activating it after the source session changes", async () => {
    const pendingFork = deferred<SummaryForkSessionResult>();
    const registered: string[] = [];
    let activeSessionId = "old-session";
    Object.assign(window.codeshell, {
      forkSession: () => pendingFork.promise,
    });

    const onContextPackageCreated = (
      result: SummaryForkSessionResult,
      options?: { shouldActivate?: () => boolean },
    ) => {
      registered.push(result.sessionId);
      if (options?.shouldActivate?.() ?? true) activeSessionId = result.sessionId;
    };
    const render = async (engineSessionId: string, contextSelectionRequest: number) => {
      await act(async () => {
        root?.render(
          <MessageStream
            messages={displayMessages}
            engineSessionId={engineSessionId}
            liveTurnActive={false}
            onContextPackageCreated={onContextPackageCreated}
            contextSelectionRequest={contextSelectionRequest}
          />,
        );
        await flushMicrotasks();
      });
    };

    await render("old-session", 0);
    await render("old-session", 1);
    await act(async () => {
      reactPropsOf(contextTurnButtons(container)[0]).onClick();
      await flushMicrotasks();
    });
    await act(async () => {
      reactPropsOf(mergeButton(container)).onClick();
      await flushMicrotasks();
    });

    expect(activeSessionId).toBe("old-session");
    activeSessionId = "new-session";
    await render("new-session", 1);
    await act(async () => {
      pendingFork.resolve(summaryResult);
      await flushMicrotasks();
    });

    expect(registered).toEqual(["packaged-target"]);
    expect(activeSessionId).toBe("new-session");
    expect(contextTurnButtons(container)).toHaveLength(0);
  });

  test("ignores a deferred packaging rejection after the source session changes", async () => {
    const oldFork = deferred<SummaryForkSessionResult>();
    const newFork = deferred<SummaryForkSessionResult>();
    Object.assign(window.codeshell, {
      forkSession: ({ sourceSessionId }: { sourceSessionId: string }) =>
        sourceSessionId === "old-session" ? oldFork.promise : newFork.promise,
    });

    const render = async (engineSessionId: string, contextSelectionRequest: number) => {
      await act(async () => {
        root?.render(
          <MessageStream
            messages={displayMessages}
            engineSessionId={engineSessionId}
            liveTurnActive={false}
            onContextPackageCreated={() => undefined}
            contextSelectionRequest={contextSelectionRequest}
          />,
        );
        await flushMicrotasks();
      });
    };

    await render("old-session", 0);
    await render("old-session", 1);
    await act(async () => {
      reactPropsOf(contextTurnButtons(container)[0]).onClick();
      await flushMicrotasks();
    });
    await act(async () => {
      reactPropsOf(mergeButton(container)).onClick();
      await flushMicrotasks();
    });

    await render("new-session", 1);
    await render("new-session", 2);
    await act(async () => {
      reactPropsOf(contextTurnButtons(container)[0]).onClick();
      await flushMicrotasks();
    });
    await act(async () => {
      reactPropsOf(mergeButton(container)).onClick();
      await flushMicrotasks();
    });
    expect(reactPropsOf(mergeButton(container)).disabled).toBe(true);

    await act(async () => {
      oldFork.reject(new Error("stale packaging failure"));
      await flushMicrotasks();
    });

    expect(renderedText(container)).not.toContain("stale packaging failure");
    expect(reactPropsOf(mergeButton(container)).disabled).toBe(true);
    expect(contextTurnButtons(container)).toHaveLength(1);
  });

  test("freezes the selected range while packaging, including manually invoked turn handlers", async () => {
    const pendingFork = deferred<SummaryForkSessionResult>();
    const calls: unknown[] = [];
    const registered: Array<{ sessionId: string; shouldActivate: boolean }> = [];
    const events: RawTranscriptEvent[] = ["first", "second", "third"].flatMap((text, index) => [
      {
        id: `u${index + 1}`,
        type: "message",
        turnNumber: index,
        timestamp: index * 2,
        data: { role: "user", content: text },
      },
      {
        id: `b${index + 1}`,
        type: "turn_boundary",
        turnNumber: index + 1,
        timestamp: index * 2 + 1,
        data: {},
      },
    ]);
    Object.assign(window.codeshell, {
      getSessionRawEvents: async () => events,
      forkSession: (params: unknown) => {
        calls.push(params);
        return pendingFork.promise;
      },
    });
    const render = async (contextSelectionRequest: number) => {
      await act(async () => {
        root?.render(
          <MessageStream
            messages={multiTurnDisplayMessages}
            engineSessionId="old-session"
            liveTurnActive={false}
            onContextPackageCreated={(result, options) => {
              registered.push({
                sessionId: result.sessionId,
                shouldActivate: options?.shouldActivate() ?? true,
              });
            }}
            contextSelectionRequest={contextSelectionRequest}
          />,
        );
        await flushMicrotasks();
      });
    };
    const selectedTurns = () =>
      findElements(container, "DIV")
        .filter((node) => reactPropsOf(node)["data-context-turn-selected"] !== undefined)
        .map((node) => reactPropsOf(node)["data-context-turn-selected"]);

    await render(0);
    await render(1);
    for (const index of [0, 1]) {
      await act(async () => {
        reactPropsOf(contextTurnButtons(container)[index]).onClick();
        await flushMicrotasks();
      });
    }
    expect(selectedTurns()).toEqual(["true", "true", "false"]);
    await act(async () => {
      reactPropsOf(mergeButton(container)).onClick();
      await flushMicrotasks();
    });

    expect(contextTurnButtons(container)).toHaveLength(3);
    expect(contextTurnButtons(container).every((button) => reactPropsOf(button).disabled)).toBe(
      true,
    );
    expect(reactPropsOf(mergeButton(container)).disabled).toBe(true);
    await act(async () => {
      // The mini-DOM can bypass the browser's disabled control protection.
      reactPropsOf(contextTurnButtons(container)[2]).onClick();
      reactPropsOf(contextTurnButtons(container)[0]).onClick();
      await flushMicrotasks();
    });
    expect(selectedTurns()).toEqual(["true", "true", "false"]);
    expect(calls).toEqual([
      {
        sourceSessionId: "old-session",
        mode: "summary",
        fromEventId: "u1",
        toEventId: "b2",
      },
    ]);

    await act(async () => {
      pendingFork.resolve({
        ...summaryResult,
        sourceRange: { fromEventId: "u1", toEventId: "b2" },
      });
      await flushMicrotasks();
    });
    expect(registered).toEqual([{ sessionId: "packaged-target", shouldActivate: true }]);
    expect(contextTurnButtons(container)).toHaveLength(0);
  });

  test("coalesces merge clicks before commit and unlocks the same selection after a failed fork", async () => {
    const firstFork = deferred<SummaryForkSessionResult>();
    const retryFork = deferred<SummaryForkSessionResult>();
    const calls: unknown[] = [];
    const registered: string[] = [];
    Object.assign(window.codeshell, {
      forkSession: (params: unknown) => {
        calls.push(params);
        return calls.length === 1 ? firstFork.promise : retryFork.promise;
      },
    });
    const render = async (contextSelectionRequest: number) => {
      await act(async () => {
        root?.render(
          <MessageStream
            messages={displayMessages}
            engineSessionId="old-session"
            liveTurnActive={false}
            onContextPackageCreated={(result) => {
              registered.push(result.sessionId);
            }}
            contextSelectionRequest={contextSelectionRequest}
          />,
        );
        await flushMicrotasks();
      });
    };

    await render(0);
    await render(1);
    await act(async () => {
      reactPropsOf(contextTurnButtons(container)[0]).onClick();
      await flushMicrotasks();
    });
    const merge = reactPropsOf(mergeButton(container)).onClick;
    await act(async () => {
      merge();
      merge();
      merge();
      // Assert before React can commit a disabled button.
      expect(calls).toHaveLength(1);
      await flushMicrotasks();
    });
    expect(reactPropsOf(mergeButton(container)).disabled).toBe(true);

    await act(async () => {
      firstFork.reject(new Error("packaging failed"));
      await flushMicrotasks();
    });
    expect(registered).toEqual([]);
    expect(renderedText(container)).toContain("packaging failed");
    expect(reactPropsOf(mergeButton(container)).disabled).toBe(false);
    expect(reactPropsOf(contextTurnButtons(container)[0]).disabled).toBe(false);
    expect(
      findElements(container, "DIV").some(
        (node) => reactPropsOf(node)["data-context-turn-selected"] === "true",
      ),
    ).toBe(true);

    const retry = reactPropsOf(mergeButton(container)).onClick;
    await act(async () => {
      retry();
      retry();
      expect(calls).toHaveLength(2);
      await flushMicrotasks();
    });
    expect(calls).toEqual([
      {
        sourceSessionId: "old-session",
        mode: "summary",
        fromEventId: "old-user",
        toEventId: "old-boundary",
      },
      calls[0],
    ]);
    expect(renderedText(container)).not.toContain("packaging failed");
    await act(async () => {
      retryFork.resolve(summaryResult);
      await flushMicrotasks();
    });
    expect(registered).toEqual(["packaged-target"]);
    expect(contextTurnButtons(container)).toHaveLength(0);
  });

  test("sends the inclusive raw-event range for a reverse continuous turn selection", async () => {
    const calls: unknown[] = [];
    const createdTitles: Array<string | undefined> = [];
    const events: RawTranscriptEvent[] = [
      {
        id: "u1",
        type: "message",
        turnNumber: 0,
        timestamp: 1,
        data: { role: "user", content: "first" },
      },
      { id: "b1", type: "turn_boundary", turnNumber: 1, timestamp: 2, data: {} },
      {
        id: "u2",
        type: "message",
        turnNumber: 1,
        timestamp: 3,
        data: { role: "user", content: "second" },
      },
      { id: "b2", type: "turn_boundary", turnNumber: 2, timestamp: 4, data: {} },
      {
        id: "u3",
        type: "message",
        turnNumber: 2,
        timestamp: 5,
        data: { role: "user", content: "third" },
      },
      { id: "b3", type: "turn_boundary", turnNumber: 3, timestamp: 6, data: {} },
    ];
    Object.assign(window.codeshell, {
      getSessionRawEvents: async () => events,
      forkSession: async (params: unknown) => {
        calls.push(params);
        return summaryResult;
      },
    });

    await act(async () => {
      root?.render(
        <MessageStream
          messages={multiTurnDisplayMessages}
          engineSessionId="old-session"
          liveTurnActive={false}
          onContextPackageCreated={(result) => createdTitles.push(result.titleSuggestion)}
          contextSelectionRequest={0}
        />,
      );
      await flushMicrotasks();
    });
    await act(async () => {
      root?.render(
        <MessageStream
          messages={multiTurnDisplayMessages}
          engineSessionId="old-session"
          liveTurnActive={false}
          onContextPackageCreated={(result) => createdTitles.push(result.titleSuggestion)}
          contextSelectionRequest={1}
        />,
      );
      await flushMicrotasks();
    });
    await act(async () => {
      reactPropsOf(contextTurnButtons(container)[2]).onClick();
      await flushMicrotasks();
    });
    await act(async () => {
      reactPropsOf(contextTurnButtons(container)[0]).onClick();
      await flushMicrotasks();
    });
    await act(async () => {
      reactPropsOf(mergeButton(container)).onClick();
      await flushMicrotasks();
    });

    expect(calls).toEqual([
      {
        sourceSessionId: "old-session",
        mode: "summary",
        fromEventId: "u1",
        toEventId: "b3",
      },
    ]);
    expect(createdTitles).toEqual(["first"]);
  });
});
