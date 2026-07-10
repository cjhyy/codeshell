import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { SessionWorkspace } from "../../preload/types";
import { ensureMiniDom, flushMicrotasks } from "../test-utils/renderHook";
import { PanelArea } from "./PanelArea";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

let root: Root | null = null;
let container: HTMLElement;
let workspaceListener: ((event: { sessionId: string }) => void) | null = null;
let requests: Array<ReturnType<typeof deferred<SessionWorkspace>>>;
const quickChatRoots: Array<string | null> = [];

beforeEach(() => {
  ensureMiniDom();
  Object.assign(globalThis, {
    localStorage: { getItem: () => null, setItem: () => undefined },
  });
  requests = [deferred<SessionWorkspace>(), deferred<SessionWorkspace>()];
  quickChatRoots.length = 0;
  let requestIndex = 0;
  Object.assign(window, {
    codeshell: {
      getSessionWorkspace: () => requests[requestIndex++]!.promise,
      onWorkspaceChanged: (listener: (event: { sessionId: string }) => void) => {
        workspaceListener = listener;
        return () => {
          workspaceListener = null;
        };
      },
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

describe("PanelArea workspace consumers", () => {
  test("gates panel bodies until resolution and updates quick chat from the matching workspace event", async () => {
    await act(async () => {
      root?.render(
        <PanelArea
          repoPath="/repo"
          onClose={() => undefined}
          tabs={[{ id: "quickChat-1", kind: "quickChat" }]}
          setTabs={() => undefined}
          activeId="quickChat-1"
          setActiveId={() => undefined}
          bucket="repo::engine-1"
          requestNonce={0}
          requestKind={null}
          engineSessionId="engine-1"
          width={480}
          onResizeStart={() => undefined}
          renderQuickChatPanel={({ cwd }) => {
            quickChatRoots.push(cwd);
            return <div data-quick-chat-root={cwd ?? "null"} />;
          }}
        />,
      );
      await flushMicrotasks();
    });
    expect(quickChatRoots).toEqual([]);

    await act(async () => {
      requests[0]!.resolve({ root: "/repo/.worktrees/one", kind: "worktree" });
      await flushMicrotasks();
    });
    expect(quickChatRoots.at(-1)).toBe("/repo/.worktrees/one");

    await act(async () => {
      workspaceListener?.({ sessionId: "other" });
      await flushMicrotasks();
    });
    expect(requests).toHaveLength(2);

    await act(async () => {
      workspaceListener?.({ sessionId: "engine-1" });
      await flushMicrotasks();
      requests[1]!.resolve({ root: "/repo/.worktrees/two", kind: "worktree" });
      await flushMicrotasks();
    });
    expect(quickChatRoots.at(-1)).toBe("/repo/.worktrees/two");
  });
});
