import { afterEach, expect, test } from "bun:test";
import React, { act } from "react";
import { ensureMiniDom, flushMicrotasks, renderHook } from "../src/test-utils/renderHook.js";
import { HubSessions, type ManagedSession } from "./HubSessions.js";

const originalFetch = globalThis.fetch;
const originalFrame = Object.getOwnPropertyDescriptor(globalThis, "requestAnimationFrame");
const originalCancelFrame = Object.getOwnPropertyDescriptor(globalThis, "cancelAnimationFrame");
afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const [name, descriptor] of [
    ["requestAnimationFrame", originalFrame],
    ["cancelAnimationFrame", originalCancelFrame],
  ] as const) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
});

function elements(node: React.ReactNode): React.ReactElement<any>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!React.isValidElement(node)) return [];
  const element = node as React.ReactElement<any>;
  return [element, ...elements(element.props.children)];
}

test.each([false, true])(
  "history open carries its managed row's workspace (archived=%s)",
  async (archived) => {
    ensureMiniDom();
    const entry: ManagedSession = {
      sessionId: "older-session-not-in-recent-catalog",
      cwd: "/owned/other-root",
      title: "Older managed conversation",
      customTitle: "",
      startedAt: 1,
      lastActiveAt: 1,
      model: "owned-fixture",
      status: "idle",
      turnCount: 1,
      archivedAt: archived ? 1 : null,
      running: false,
    };
    const frames = new Map<number, FrameRequestCallback>();
    let frameId = 0;
    globalThis.requestAnimationFrame = (callback) => {
      frames.set(++frameId, callback);
      return frameId;
    };
    globalThis.cancelAnimationFrame = (id) => void frames.delete(id);
    const calls: Array<{ path: string; method: string }> = [];
    let finishRestore!: (response: Response) => void;
    const restore = new Promise<Response>((resolve) => {
      finishRestore = resolve;
    });
    globalThis.fetch = (async (input, init) => {
      const url = new URL(String(input), "http://localhost");
      expect(url.origin).toBe("http://localhost");
      const method = init?.method ?? "GET";
      calls.push({ path: url.pathname, method });
      if (url.pathname === "/api/v1/sessions" && method === "GET")
        return Response.json({
          sessions: entry.archivedAt === null && archived ? [] : [entry],
          nextCursor: null,
        });
      expect(url.pathname).toBe(`/api/v1/sessions/${entry.sessionId}`);
      expect(method).toBe("PATCH");
      expect(JSON.parse(String(init?.body))).toEqual({ archived: false });
      return restore;
    }) as typeof fetch;
    const opened: Parameters<React.ComponentProps<typeof HubSessions>["onOpen"]>[] = [];
    const props = {
      onAuthLost: () => {
        throw new Error("Unexpected fixture auth loss");
      },
      onOpen: (...args: Parameters<React.ComponentProps<typeof HubSessions>["onOpen"]>) => {
        opened.push(args);
      },
    };
    const hook = await renderHook(() => HubSessions(props));
    const source = document.createElement("button");
    document.body.appendChild(source);
    try {
      const title = elements(hook.result.current).find(
        (element) => element.props.className === "session-history-title",
      );
      expect(title).toBeDefined();
      source.focus();
      await act(async () => {
        title!.props.onClick({ currentTarget: source });
        await flushMicrotasks();
      });
      if (archived) {
        expect(opened).toEqual([]);
        // Restoring removes this row from the refreshed archived catalog. Its
        // workspace must survive until the later guarded navigation callback.
        entry.archivedAt = null;
        await act(async () => {
          finishRestore(Response.json({}));
          await flushMicrotasks();
        });
        expect(opened).toEqual([]);
        expect(frames.size).toBe(1);
        await act(async () => {
          for (const [id, callback] of frames) {
            frames.delete(id);
            callback(0);
          }
          await flushMicrotasks();
        });
      }
      expect(opened).toHaveLength(1);
      expect(opened[0][0]).toBe(entry.sessionId);
      expect(opened[0][1]?.source).toBe(source);
      expect(opened[0][2]).toBe("/owned/other-root");
      expect(calls.filter((call) => call.method === "PATCH")).toHaveLength(archived ? 1 : 0);
    } finally {
      await hook.unmount();
      document.body.removeChild(source);
    }
  },
);
