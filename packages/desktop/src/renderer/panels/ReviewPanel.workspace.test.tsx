import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ReviewGitCommit } from "../../preload/types";
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
    const requests = [deferred<ReviewGitCommit[]>(), deferred<ReviewGitCommit[]>()];
    let requestIndex = 0;
    Object.assign(window, {
      codeshell: {
        getReviewRecentCommits: () => requests[requestIndex++]!.promise,
      },
    });

    let cwd = "/repo-a";
    const hook = await renderHook(() => useWorkspaceRecentCommits("session-1", cwd));
    cleanup = hook.unmount;
    hook.result.current.loadCommits();

    cwd = "/repo-b";
    await hook.rerender();
    hook.result.current.loadCommits();
    await act(async () => {
      requests[1]!.resolve([
        {
          hash: "bbbb",
          shortHash: "bbbb",
          subject: "B commit",
          relativeDate: "now",
          rootId: "root-b",
          rootIds: ["root-b"],
          repoRoot: "/repo-b",
        },
      ]);
      await flushMicrotasks();
    });
    expect(hook.result.current.commits?.[0]?.hash).toBe("bbbb");

    await act(async () => {
      requests[0]!.resolve([
        {
          hash: "aaaa",
          shortHash: "aaaa",
          subject: "A stale commit",
          relativeDate: "old",
          rootId: "root-a",
          rootIds: ["root-a"],
          repoRoot: "/repo-a",
        },
      ]);
      await flushMicrotasks();
    });
    expect(hook.result.current.commits?.[0]?.hash).toBe("bbbb");
  });

  test("passes the authoritative Session id instead of a renderer cwd to Review Git", async () => {
    const requests: unknown[][] = [];
    Object.assign(window, {
      codeshell: {
        getReviewDiff: async (...args: unknown[]) => {
          requests.push(args);
          return { repositories: [], errors: [] };
        },
      },
    });
    const container = document.createElement("div") as unknown as HTMLElement;
    root = createRoot(container);

    await act(async () => {
      root?.render(<ReviewPanel cwd="/renderer-spoofed-cwd" sessionId="authoritative-session" />);
      await flushMicrotasks();
    });
    expect(requests).toContainEqual(["authoritative-session", { kind: "working", mode: "all" }]);
    expect(JSON.stringify(requests)).not.toContain("renderer-spoofed-cwd");
  });
});
