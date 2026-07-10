import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import type { SessionWorkspace } from "../../preload/types";
import { ensureMiniDom, flushMicrotasks, renderHook } from "../test-utils/renderHook";
import { usePanelWorkspaceRoot } from "./usePanelWorkspaceRoot";

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

let cleanup: (() => Promise<void>) | null = null;

afterEach(async () => {
  await cleanup?.();
  cleanup = null;
});

describe("usePanelWorkspaceRoot", () => {
  test("uses null for no-repo buckets and the repo root for drafts without IPC", async () => {
    ensureMiniDom();
    let calls = 0;
    Object.assign(window, {
      codeshell: {
        getSessionWorkspace: async () => {
          calls += 1;
          return { root: "/unexpected", kind: "main" } as SessionWorkspace;
        },
        onWorkspaceChanged: () => () => {},
      },
    });

    let sessionId: string | null = null;
    let repoPath: string | null = null;
    const hook = await renderHook(() => usePanelWorkspaceRoot(sessionId, repoPath));
    cleanup = hook.unmount;
    expect(hook.result.current).toEqual({ root: null, kind: null, ready: true });

    repoPath = "/repo";
    await hook.rerender();
    expect(hook.result.current).toEqual({ root: "/repo", kind: "main", ready: true });
    expect(calls).toBe(0);
  });

  test("waits for and returns the engine session worktree", async () => {
    ensureMiniDom();
    const request = deferred<SessionWorkspace>();
    const calls: Array<[string, string]> = [];
    Object.assign(window, {
      codeshell: {
        getSessionWorkspace: (sessionId: string, cwd: string) => {
          calls.push([sessionId, cwd]);
          return request.promise;
        },
        onWorkspaceChanged: () => () => {},
      },
    });

    const hook = await renderHook(() => usePanelWorkspaceRoot("engine-1", "/repo"));
    cleanup = hook.unmount;
    expect(hook.result.current).toEqual({ root: null, kind: null, ready: false });
    expect(calls).toEqual([["engine-1", "/repo"]]);

    await act(async () => {
      request.resolve({ root: "/repo/.worktrees/feature", kind: "worktree" });
      await flushMicrotasks();
    });
    expect(hook.result.current).toEqual({
      root: "/repo/.worktrees/feature",
      kind: "worktree",
      ready: true,
    });
  });

  test("does not let an old session response overwrite the new bucket", async () => {
    ensureMiniDom();
    const first = deferred<SessionWorkspace>();
    const second = deferred<SessionWorkspace>();
    Object.assign(window, {
      codeshell: {
        getSessionWorkspace: (sessionId: string) =>
          sessionId === "engine-a" ? first.promise : second.promise,
        onWorkspaceChanged: () => () => {},
      },
    });

    let sessionId = "engine-a";
    let repoPath = "/repo-a";
    const hook = await renderHook(() => usePanelWorkspaceRoot(sessionId, repoPath));
    cleanup = hook.unmount;

    sessionId = "engine-b";
    repoPath = "/repo-b";
    await hook.rerender();
    await act(async () => {
      second.resolve({ root: "/repo-b/.worktrees/current", kind: "worktree" });
      await flushMicrotasks();
      first.resolve({ root: "/repo-a/.worktrees/stale", kind: "worktree" });
      await flushMicrotasks();
    });

    expect(hook.result.current.root).toBe("/repo-b/.worktrees/current");
  });

  test("refreshes only for matching workspace events and unsubscribes", async () => {
    ensureMiniDom();
    let listener: ((event: { sessionId: string }) => void) | null = null;
    let unsubscribed = 0;
    let calls = 0;
    const roots = ["/repo", "/repo/.worktrees/next"];
    Object.assign(window, {
      codeshell: {
        getSessionWorkspace: async () => ({
          root: roots[Math.min(calls++, roots.length - 1)]!,
          kind: calls === 1 ? "main" : "worktree",
        }),
        onWorkspaceChanged: (cb: (event: { sessionId: string }) => void) => {
          listener = cb;
          return () => {
            listener = null;
            unsubscribed += 1;
          };
        },
      },
    });

    const hook = await renderHook(() => usePanelWorkspaceRoot("engine-1", "/repo"));
    cleanup = hook.unmount;
    expect(calls).toBe(1);

    await act(async () => {
      listener?.({ sessionId: "engine-other" });
      await flushMicrotasks();
    });
    expect(calls).toBe(1);

    await act(async () => {
      listener?.({ sessionId: "engine-1" });
      await flushMicrotasks();
    });
    expect(calls).toBe(2);
    expect(hook.result.current.root).toBe("/repo/.worktrees/next");

    await hook.unmount();
    cleanup = null;
    expect(unsubscribed).toBe(1);
  });

  test("falls back to this bucket's repository after IPC failure", async () => {
    ensureMiniDom();
    Object.assign(window, {
      codeshell: {
        getSessionWorkspace: async () => {
          throw new Error("unavailable");
        },
        onWorkspaceChanged: () => () => {},
      },
    });

    const hook = await renderHook(() => usePanelWorkspaceRoot("engine-1", "/repo"));
    cleanup = hook.unmount;
    expect(hook.result.current).toEqual({
      root: "/repo",
      kind: "main",
      ready: true,
      error: "unavailable",
    });
  });
});
