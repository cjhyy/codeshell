import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { RawTranscriptEvent, SummaryForkSessionResult } from "../preload/types";
import { ensureMiniDom, flushMicrotasks } from "./test-utils/renderHook";
import { MessageStream } from "./MessageStream";

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
  const current = node as { childNodes?: unknown[]; data?: string; nodeType?: number };
  if (current.nodeType === 3) return current.data ?? "";
  return (current.childNodes ?? []).map(renderedText).join("");
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
    const render = async (engineSessionId: string) => {
      await act(async () => {
        root?.render(
          <MessageStream
            messages={[]}
            engineSessionId={engineSessionId}
            liveTurnActive={false}
            onContextPackageCreated={() => undefined}
          />,
        );
        await flushMicrotasks();
      });
    };

    await render("old-session");
    const openButton = findElements(container, "BUTTON")[0];
    expect(openButton).toBeDefined();
    await act(async () => {
      reactPropsOf(openButton).onClick();
      await flushMicrotasks();
    });
    expect(findElements(container, "BUTTON").length).toBeGreaterThan(1);

    await render("new-session");

    expect(findElements(container, "BUTTON")).toHaveLength(1);
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
    const render = async (engineSessionId: string) => {
      await act(async () => {
        root?.render(
          <MessageStream
            messages={[]}
            engineSessionId={engineSessionId}
            liveTurnActive={false}
            onContextPackageCreated={onContextPackageCreated}
          />,
        );
        await flushMicrotasks();
      });
    };

    await render("old-session");
    await act(async () => {
      reactPropsOf(findElements(container, "BUTTON")[0]).onClick();
      await flushMicrotasks();
    });
    await act(async () => {
      reactPropsOf(findElements(container, "BUTTON")[1]).onClick();
      await flushMicrotasks();
    });
    await act(async () => {
      reactPropsOf(findElements(container, "BUTTON")[2]).onClick();
      await flushMicrotasks();
    });

    expect(activeSessionId).toBe("old-session");
    activeSessionId = "new-session";
    await render("new-session");
    await act(async () => {
      pendingFork.resolve(summaryResult);
      await flushMicrotasks();
    });

    expect(registered).toEqual(["packaged-target"]);
    expect(activeSessionId).toBe("new-session");
    expect(findElements(container, "BUTTON")).toHaveLength(1);
  });

  test("ignores a deferred packaging rejection after the source session changes", async () => {
    const oldFork = deferred<SummaryForkSessionResult>();
    const newFork = deferred<SummaryForkSessionResult>();
    Object.assign(window.codeshell, {
      forkSession: ({ sourceSessionId }: { sourceSessionId: string }) =>
        sourceSessionId === "old-session" ? oldFork.promise : newFork.promise,
    });

    const render = async (engineSessionId: string) => {
      await act(async () => {
        root?.render(
          <MessageStream
            messages={[]}
            engineSessionId={engineSessionId}
            liveTurnActive={false}
            onContextPackageCreated={() => undefined}
          />,
        );
        await flushMicrotasks();
      });
    };

    await render("old-session");
    await act(async () => {
      reactPropsOf(findElements(container, "BUTTON")[0]).onClick();
      await flushMicrotasks();
    });
    await act(async () => {
      reactPropsOf(findElements(container, "BUTTON")[1]).onClick();
      await flushMicrotasks();
    });
    await act(async () => {
      reactPropsOf(findElements(container, "BUTTON")[2]).onClick();
      await flushMicrotasks();
    });

    await render("new-session");
    await act(async () => {
      reactPropsOf(findElements(container, "BUTTON")[0]).onClick();
      await flushMicrotasks();
    });
    await act(async () => {
      reactPropsOf(findElements(container, "BUTTON")[1]).onClick();
      await flushMicrotasks();
    });
    await act(async () => {
      reactPropsOf(findElements(container, "BUTTON")[2]).onClick();
      await flushMicrotasks();
    });
    expect(reactPropsOf(findElements(container, "BUTTON")[2]).disabled).toBe(true);

    await act(async () => {
      oldFork.reject(new Error("stale packaging failure"));
      await flushMicrotasks();
    });

    expect(renderedText(container)).not.toContain("stale packaging failure");
    expect(reactPropsOf(findElements(container, "BUTTON")[2]).disabled).toBe(true);
    expect(findElements(container, "BUTTON")).toHaveLength(3);
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
          messages={[]}
          engineSessionId="old-session"
          liveTurnActive={false}
          onContextPackageCreated={(result) => createdTitles.push(result.titleSuggestion)}
        />,
      );
      await flushMicrotasks();
    });
    await act(async () => {
      reactPropsOf(findElements(container, "BUTTON")[0]).onClick();
      await flushMicrotasks();
    });
    await act(async () => {
      const buttons = findElements(container, "BUTTON");
      reactPropsOf(buttons[3]).onClick();
      await flushMicrotasks();
    });
    await act(async () => {
      reactPropsOf(findElements(container, "BUTTON")[1]).onClick();
      await flushMicrotasks();
    });
    await act(async () => {
      reactPropsOf(findElements(container, "BUTTON")[4]).onClick();
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
