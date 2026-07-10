import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { GitCommit } from "../../preload/types";
import { ensureMiniDom, flushMicrotasks, renderHook } from "../test-utils/renderHook";
import { ReviewPanel, useWorkspaceRecentCommits } from "./ReviewPanel";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

let cleanup: (() => Promise<void>) | null = null;
let root: Root | null = null;

beforeEach(() => {
  ensureMiniDom();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: { getItem: () => null, setItem: () => undefined },
  });
});

afterEach(async () => {
  await cleanup?.();
  cleanup = null;
  await act(async () => {
    root?.unmount();
    await flushMicrotasks();
  });
  root = null;
});

describe("ReviewPanel workspace requests", () => {
  test("ignores an older workspace's commit response", async () => {
    const requests = {
      "/repo-a": deferred<GitCommit[]>(),
      "/repo-b": deferred<GitCommit[]>(),
    };
    Object.assign(window, {
      codeshell: {
        getGitRecentCommits: (cwd: string) => requests[cwd as keyof typeof requests].promise,
      },
    });

    let cwd = "/repo-a";
    const hook = await renderHook(() => useWorkspaceRecentCommits(cwd));
    cleanup = hook.unmount;
    hook.result.current.loadCommits();

    cwd = "/repo-b";
    await hook.rerender();
    hook.result.current.loadCommits();
    await act(async () => {
      requests["/repo-b"].resolve([
        { hash: "bbbb", subject: "B commit", author: "B", relativeDate: "now" },
      ]);
      await flushMicrotasks();
    });
    expect(hook.result.current.commits?.[0]?.hash).toBe("bbbb");

    await act(async () => {
      requests["/repo-a"].resolve([
        { hash: "aaaa", subject: "A stale commit", author: "A", relativeDate: "old" },
      ]);
      await flushMicrotasks();
    });
    expect(hook.result.current.commits?.[0]?.hash).toBe("bbbb");
  });

  test("passes the resolved root to the git diff consumer", async () => {
    const diffRoots: string[] = [];
    Object.assign(window, {
      codeshell: {
        getGitDiff: async (cwd: string) => {
          diffRoots.push(cwd);
          return "";
        },
      },
    });
    const container = document.createElement("div") as unknown as HTMLElement;
    root = createRoot(container);

    await act(async () => {
      root?.render(<ReviewPanel cwd="/repo/.worktrees/feature" />);
      await flushMicrotasks();
    });
    expect(diffRoots).toContain("/repo/.worktrees/feature");
  });
});
