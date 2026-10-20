import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ReviewGitCommit } from "../../preload/types";
import { ensureMiniDom, flushMicrotasks, renderHook } from "../test-utils/renderHook";
import { ReviewPanel, useWorkspaceRecentCommits } from "./ReviewPanel";
import { onComposerSeedRequest } from "../chat/composerSeed";
import { SimpleSelect } from "../components/ui/simple-select";
import { UnifiedDiffViewer } from "../diff/UnifiedDiffViewer";

// Read only public component props; keep the actual select/viewer mounted.
function componentProps(container: HTMLElement, component: unknown): any {
  for (const node of nodes(container)) {
    const key = Object.keys(node).find((name) => name.startsWith("__reactFiber$"));
    let fiber = key ? node[key] : null;
    while (fiber) {
      if (fiber.type === component) return fiber.memoizedProps;
      fiber = fiber.return;
    }
  }
  throw new Error("component not rendered");
}

function domProps(node: any): any {
  const key = Object.keys(node).find((name) => name.startsWith("__reactProps$"));
  if (!key) throw new Error("element props unavailable");
  return node[key];
}

async function chooseReviewFile(container: HTMLElement, label: string): Promise<void> {
  const select = componentProps(container, SimpleSelect);
  const option = select.options.find((item: any) => item.label === label);
  if (!option) throw new Error(`missing option ${label}`);
  await act(async () => {
    select.onChange(option.value);
    await flushMicrotasks();
  });
}

async function clickButton(container: HTMLElement, label: string): Promise<void> {
  const button = nodes(container).find(
    (node) =>
      node.tagName?.toLowerCase() === "button" &&
      (node.getAttribute?.("aria-label") === label || text(node) === label),
  );
  if (!button) throw new Error(`missing button ${label}`);
  await act(async () => {
    domProps(button).onClick();
    await flushMicrotasks();
  });
}

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
  test("a file named __all__ is a single-file filter for both viewer and review draft", async () => {
    const requests: any[][] = [];
    Object.assign(window, {
      codeshell: {
        prepareReviewPrompt: async (...args: any[]) => {
          requests.push(args);
          return { prompt: "owned draft", truncated: false };
        },
      },
    });
    const unsubscribe = onComposerSeedRequest(() => true);
    const special = snapshot.replaceAll("note.txt", "__all__");
    const other = snapshot.replaceAll("note.txt", "other.txt");
    const container = document.createElement("div");
    root = createRoot(container);
    try {
      await act(async () => {
        root?.render(
          <ReviewPanel
            cwd="/repo"
            sessionId="session-a"
            gitAvailable={false}
            turnDiff={special + other}
          />,
        );
        await flushMicrotasks();
      });
      await chooseReviewFile(container, "__all__");
      await clickButton(container, "准备 AI 代码审查");
      await clickButton(container, "添加审查草稿");
      expect({
        onlyPath: componentProps(container, UnifiedDiffViewer).onlyPath,
        visiblePaths: nodes(container)
          .map((node) => node.getAttribute?.("title"))
          .filter((title) => title === "__all__" || title === "other.txt"),
        request: requests[0],
      }).toEqual({
        onlyPath: "__all__",
        visiblePaths: ["__all__"],
        request: [
          "session-a",
          { kind: "snapshot", diff: special, label: "__all__", instructions: "" },
        ],
      });
      await chooseReviewFile(container, "全部文件（2）");
      await clickButton(container, "添加审查草稿");
      expect(componentProps(container, UnifiedDiffViewer).onlyPath).toBeNull();
      expect(text(container)).toContain("other.txt");
      expect(requests[1]).toEqual([
        "session-a",
        { kind: "snapshot", diff: special + other, label: undefined, instructions: "" },
      ]);
    } finally {
      unsubscribe();
    }
  });

  test("file option values preserve special path text and cannot collide with select control values", async () => {
    const paths = [
      "__simple_select_empty__",
      "all",
      "path:__all__",
      "文 件/说明.txt",
      'quote"name.txt',
      "back\\slash.txt",
    ];
    const patchFor = (path: string) => {
      const oldPath = JSON.stringify(`a/${path}`);
      const newPath = JSON.stringify(`b/${path}`);
      return `diff --git ${oldPath} ${newPath}\n--- ${oldPath}\n+++ ${newPath}\n@@ -1 +1 @@\n-old\n+new\n`;
    };
    const diff = paths.map(patchFor).join("");
    const requests: any[][] = [];
    Object.assign(window, {
      codeshell: {
        prepareReviewPrompt: async (...args: any[]) => {
          requests.push(args);
          return { prompt: "owned draft", truncated: false };
        },
      },
    });
    const unsubscribe = onComposerSeedRequest(() => true);
    const container = document.createElement("div");
    root = createRoot(container);
    try {
      await act(async () => {
        root?.render(
          <ReviewPanel cwd="/repo" sessionId="session-a" gitAvailable={false} turnDiff={diff} />,
        );
        await flushMicrotasks();
      });
      const values = componentProps(container, SimpleSelect).options.map(
        (option: any) => option.value,
      );
      expect(new Set(values).size).toBe(paths.length + 1);
      expect(values).not.toContain("");
      expect(values).not.toContain("__simple_select_empty__");
      await clickButton(container, "准备 AI 代码审查");
      for (const [index, path] of paths.entries()) {
        await chooseReviewFile(container, path);
        await clickButton(container, "添加审查草稿");
        expect(componentProps(container, UnifiedDiffViewer).onlyPath).toBe(path);
        expect(
          nodes(container).filter((node) => node.getAttribute?.("title") === path),
        ).toHaveLength(1);
        expect(requests[index]).toEqual([
          "session-a",
          { kind: "snapshot", diff: patchFor(path), label: path, instructions: "" },
        ]);
      }
      // A cleared/obsolete control value is never interpreted as a literal path.
      await act(async () => {
        componentProps(container, SimpleSelect).onChange("");
        await flushMicrotasks();
      });
      expect(componentProps(container, UnifiedDiffViewer).onlyPath).toBeNull();
      await clickButton(container, "添加审查草稿");
      expect(requests.at(-1)).toEqual([
        "session-a",
        { kind: "snapshot", diff, label: undefined, instructions: "" },
      ]);
    } finally {
      unsubscribe();
    }
  });

  test("repeated historical edits render one file block and one menu option per path", async () => {
    const second = snapshot.replace("after-note", "after-second-edit");
    const other = snapshot.replaceAll("note.txt", "other.txt");
    const container = document.createElement("div");
    root = createRoot(container);
    await act(async () => {
      root?.render(
        <ReviewPanel
          cwd="/repo"
          sessionId="session-a"
          gitAvailable={false}
          turnDiff={snapshot + other + second}
        />,
      );
      await flushMicrotasks();
    });
    expect(
      nodes(container).filter((node) => node.getAttribute?.("title") === "note.txt"),
    ).toHaveLength(1);
    expect(
      nodes(container).filter((node) => node.getAttribute?.("title") === "other.txt"),
    ).toHaveLength(1);
    expect(text(container)).toContain("after-note");
    expect(text(container)).toContain("after-second-edit");
    // The file selector counts files rather than sequential edit operations.
    expect(text(container)).toContain("全部文件（2）");
    expect(text(container)).not.toContain("全部文件（3）");
  });

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

  test("does not mount a Git viewer without a repository or a supplied snapshot", async () => {
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
    for (const turnDiff of [undefined]) {
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

  test("an explicit empty turn snapshot never falls back to unrelated working-tree changes", async () => {
    const requests: unknown[] = [];
    Object.assign(window, {
      codeshell: {
        getReviewDiff: async (...args: unknown[]) => {
          requests.push(args);
          throw new Error("must not query the live repository for an empty turn");
        },
      },
    });
    const container = document.createElement("div");
    root = createRoot(container);
    for (const gitAvailable of [true, false]) {
      for (const turnDiff of ["", " \n\t"]) {
        await act(async () => {
          root?.render(
            <ReviewPanel
              cwd="/repo"
              sessionId="session-a"
              gitAvailable={gitAvailable}
              files={["a.ts"]}
              turnDiff={turnDiff}
            />,
          );
          await flushMicrotasks();
        });
        expect(text(container)).toContain("no changes");
      }
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

    await chooseReviewFile(container, "a.ts");
    expect(text(container)).toContain("after-a");
    expect(text(container)).not.toContain("after-b");

    await render(["c", "d"]);
    expect(text(container)).toContain("after-c");
    expect(text(container)).toContain("after-d");
    expect(componentProps(container, UnifiedDiffViewer).onlyPath).toBeNull();

    // Restoring an earlier path must not reactivate an unavailable selection.
    await render(["a", "b"]);
    expect(componentProps(container, UnifiedDiffViewer).onlyPath).toBeNull();
    expect(text(container)).toContain("after-a");
    expect(text(container)).toContain("after-b");
    await chooseReviewFile(container, "a.ts");
    const obsoleteSelect = componentProps(container, SimpleSelect);
    const obsoleteValue = obsoleteSelect.options.find(
      (option: any) => option.label === "a.ts",
    ).value;
    await render([]);
    expect(componentProps(container, UnifiedDiffViewer).onlyPath).toBeNull();
    expect(hasControl(container, "选择文件")).toBe(false);
    expect(text(container)).toContain("no changes");
    await act(async () => {
      obsoleteSelect.onChange(obsoleteValue);
      await flushMicrotasks();
    });
    await render(["a", "b"]);
    expect(componentProps(container, UnifiedDiffViewer).onlyPath).toBeNull();
    expect(text(container)).toContain("after-a");
    expect(text(container)).toContain("after-b");
  });
});
