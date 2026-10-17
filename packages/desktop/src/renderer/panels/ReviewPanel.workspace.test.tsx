import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ReviewGitCommit } from "../../preload/types";
import { ensureMiniDom, flushMicrotasks, renderHook } from "../test-utils/renderHook";
import { ReviewPanel, useWorkspaceRecentCommits } from "./ReviewPanel";
import { onComposerSeedRequest } from "../chat/composerSeed";

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
  test("the AI review action prepares the historical snapshot and custom focus as a draft", async () => {
    const requests: unknown[][] = [];
    const drafts: unknown[] = [];
    Object.assign(window, {
      codeshell: {
        prepareReviewPrompt: async (...args: unknown[]) => {
          requests.push(args);
          return { prompt: "Review the historical changes", truncated: false };
        },
      },
    });
    const unsubscribe = onComposerSeedRequest((draft) => {
      drafts.push(draft);
      return true;
    });
    const container = document.createElement("div");
    root = createRoot(container);
    const propsOf = (node: any) => {
      const key = Object.keys(node).find((key) => key.startsWith("__reactProps$"));
      return key ? node[key] : null;
    };
    try {
      await act(async () => {
        root?.render(
          <ReviewPanel
            cwd="/repo"
            sessionId="session-a"
            gitAvailable={false}
            turnDiff={snapshot}
          />,
        );
        await flushMicrotasks();
      });
      const open = nodes(container).find(
        (node) => node.getAttribute?.("aria-label") === "准备 AI 代码审查",
      );
      await act(async () => {
        propsOf(open).onClick();
        await flushMicrotasks();
      });
      const textarea = nodes(container).find((node) => node.tagName?.toLowerCase() === "textarea");
      await act(async () => {
        propsOf(textarea).onChange({ target: { value: "检查权限边界" } });
        await flushMicrotasks();
      });
      const add = nodes(container).find(
        (node) => node.tagName?.toLowerCase() === "button" && text(node) === "添加审查草稿",
      );
      await act(async () => {
        propsOf(add).onClick();
        await flushMicrotasks();
      });
      expect(requests).toEqual([
        [
          "session-a",
          {
            kind: "snapshot",
            diff: snapshot,
            label: undefined,
            instructions: "检查权限边界",
          },
        ],
      ]);
      expect(drafts).toEqual([
        { source: "code-review", text: "Review the historical changes", sessionId: "session-a" },
      ]);
      expect(text(container)).toContain("已添加到对话输入框");
    } finally {
      unsubscribe();
    }
  });

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
