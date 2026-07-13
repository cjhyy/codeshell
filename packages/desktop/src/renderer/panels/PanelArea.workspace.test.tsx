import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { SessionWorkspace } from "../../preload/types";
import { ensureMiniDom, flushMicrotasks } from "../test-utils/renderHook";
import {
  PanelWorkspaceRootConsumer,
  panelWorkspaceBodyReady,
  panelWorkspacePresentation,
} from "./PanelWorkspaceRootConsumer";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

let root: Root | null = null;
let workspaceListener: ((event: { sessionId: string }) => void) | null = null;
let requests: Array<ReturnType<typeof deferred<SessionWorkspace>>>;
let requestCount = 0;
const quickChatRoots: Array<string | null> = [];

beforeEach(() => {
  ensureMiniDom();
  requests = [deferred<SessionWorkspace>(), deferred<SessionWorkspace>()];
  requestCount = 0;
  quickChatRoots.length = 0;
  Object.assign(window, {
    codeshell: {
      getSessionWorkspace: () => requests[requestCount++]!.promise,
      onWorkspaceChanged: (listener: (event: { sessionId: string }) => void) => {
        workspaceListener = listener;
        return () => {
          workspaceListener = null;
        };
      },
    },
  });
  const container = document.createElement("div") as unknown as HTMLElement;
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
  test("covers a retained panel body while a changed workspace is resolving", () => {
    expect(panelWorkspacePresentation({ root: null, kind: null, ready: false })).toEqual({
      mountBody: false,
      showLoading: true,
    });
    expect(
      panelWorkspacePresentation({ root: "/repo/.worktrees/one", kind: "worktree", ready: true }),
    ).toEqual({ mountBody: true, showLoading: false });
    expect(
      panelWorkspacePresentation({ root: "/repo/.worktrees/one", kind: "worktree", ready: false }),
    ).toEqual({
      mountBody: true,
      showLoading: true,
    });
  });

  test("gates bodies until resolution and updates quick chat from the matching workspace event", async () => {
    await act(async () => {
      root?.render(
        <PanelWorkspaceRootConsumer engineSessionId="engine-1" projectPath="/repo">
          {(workspace) => {
            if (!panelWorkspaceBodyReady(workspace)) return <div data-loading />;
            quickChatRoots.push(workspace.root);
            return <div data-quick-chat-root={workspace.root ?? "null"} />;
          }}
        </PanelWorkspaceRootConsumer>,
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
    expect(requestCount).toBe(1);

    await act(async () => {
      workspaceListener?.({ sessionId: "engine-1" });
      await flushMicrotasks();
      requests[1]!.resolve({ root: "/repo/.worktrees/two", kind: "worktree" });
      await flushMicrotasks();
    });
    expect(quickChatRoots.at(-1)).toBe("/repo/.worktrees/two");
  });
});
