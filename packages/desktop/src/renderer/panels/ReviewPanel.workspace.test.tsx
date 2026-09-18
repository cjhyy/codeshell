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

const nodes = (node: any): any[] => [node, ...(node.childNodes ?? []).flatMap(nodes)];
const text = (node: any): string =>
  node.nodeType === 3
    ? (node.nodeValue ?? node.textContent ?? "")
    : node.childNodes?.length
      ? node.childNodes.map(text).join("")
      : (node.textContent ?? "");
const hasControl = (container: HTMLElement, label: string): boolean =>
  nodes(container).some((node) => node.getAttribute?.("aria-label") === label);
const snapshot =
  "diff --git a/note.txt b/note.txt\n--- a/note.txt\n+++ b/note.txt\n@@ -1 +1 @@\n-before-note\n+after-note\n";

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

  test("shows a historical snapshot without Git, a Session, or a separate files list", async () => {
    const requests: string[] = [];
    Object.assign(window, {
      codeshell: {
        getReviewDiff: async () => {
          requests.push("diff");
          return { repositories: [], errors: [] };
        },
        getReviewRecentCommits: async () => {
          requests.push("commits");
          return [];
        },
      },
    });
    const container = document.createElement("div");
    root = createRoot(container);
    await act(async () => {
      root?.render(
        <ReviewPanel
          cwd="/plain-folder"
          sessionId={null}
          gitAvailable={false}
          turnDiff={snapshot}
        />,
      );
      await flushMicrotasks();
    });

    expect(text(container)).toContain("after-note");
    expect(hasControl(container, "选择审查范围")).toBe(false);
    expect(hasControl(container, "刷新")).toBe(false);
    expect(requests).toEqual([]);
  });

  test("does not mount a Git viewer without a repository or a nonempty snapshot", async () => {
    const requests: string[] = [];
    Object.assign(window, {
      codeshell: {
        getReviewDiff: async () => {
          requests.push("diff");
          return { repositories: [], errors: [] };
        },
      },
    });
    const container = document.createElement("div");
    root = createRoot(container);
    for (const turnDiff of [undefined, " \n\t"]) {
      await act(async () => {
        root?.render(
          <ReviewPanel
            cwd="/plain-folder"
            sessionId="session"
            gitAvailable={false}
            files={["note.txt"]}
            turnDiff={turnDiff}
          />,
        );
        await flushMicrotasks();
      });
      expect(container.childNodes.length).toBe(0);
    }
    expect(requests).toEqual([]);
  });

  test("stops the previous Git scope immediately when unavailable and restores Git controls", async () => {
    const requests: unknown[][] = [];
    Object.assign(window, {
      codeshell: {
        getReviewDiff: async (...args: unknown[]) => {
          requests.push(args);
          return { repositories: [], errors: [] };
        },
      },
    });
    const container = document.createElement("div");
    root = createRoot(container);
    const render = async (gitAvailable: boolean, turnDiff?: string) => {
      await act(async () => {
        root?.render(
          <ReviewPanel
            cwd="/folder"
            sessionId="session"
            gitAvailable={gitAvailable}
            turnDiff={turnDiff}
          />,
        );
        await flushMicrotasks();
      });
    };

    await render(true);
    expect(requests).toEqual([["session", { kind: "working", mode: "all" }]]);
    expect(hasControl(container, "选择审查范围")).toBe(true);
    expect(hasControl(container, "刷新")).toBe(true);

    await render(false, snapshot);
    expect(text(container)).toContain("after-note");
    expect(hasControl(container, "选择审查范围")).toBe(false);
    expect(hasControl(container, "刷新")).toBe(false);
    expect(requests).toHaveLength(1);

    await render(false);
    expect(container.childNodes.length).toBe(0);
    expect(requests).toHaveLength(1);

    await render(true);
    expect(hasControl(container, "选择审查范围")).toBe(true);
    expect(hasControl(container, "刷新")).toBe(true);
    expect(requests).toHaveLength(2);
  });

  test("opening another turn clears an unavailable file filter instead of rendering an empty diff", async () => {
    const diff = (name: string) =>
      `diff --git a/${name}.ts b/${name}.ts\n--- a/${name}.ts\n+++ b/${name}.ts\n@@ -1 +1 @@\n-before-${name}\n+after-${name}\n`;
    const container = document.createElement("div");
    root = createRoot(container);
    const render = async (names: string[]) => {
      await act(async () => {
        root?.render(
          <ReviewPanel
            cwd="/repo"
            sessionId="session"
            files={names.map((name) => `${name}.ts`)}
            turnDiff={names.map(diff).join("")}
          />,
        );
        await flushMicrotasks();
      });
    };
    await render(["a", "b"]);

    // Reach the real select's public onChange prop through its rendered trigger;
    // no module mock replaces the real diff viewer or leaks into other suites.
    let chooseFile: ((value: string) => void) | undefined;
    for (const node of nodes(container)) {
      const key = Object.keys(node).find((key) => key.startsWith("__reactFiber$"));
      let fiber = key ? node[key] : null;
      while (fiber) {
        if (fiber.memoizedProps?.options?.some((option: any) => option.value === "a.ts")) {
          chooseFile = fiber.memoizedProps.onChange;
          break;
        }
        fiber = fiber.return;
      }
      if (chooseFile) break;
    }
    expect(chooseFile).toBeFunction();
    await act(async () => {
      chooseFile!("a.ts");
      await flushMicrotasks();
    });
    expect(text(container)).toContain("after-a");
    expect(text(container)).not.toContain("after-b");

    await render(["c", "d"]);
    expect(text(container)).toContain("after-c");
    expect(text(container)).toContain("after-d");
  });
});
