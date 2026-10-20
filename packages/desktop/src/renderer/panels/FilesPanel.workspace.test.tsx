import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ensureMiniDom, flushMicrotasks } from "../test-utils/renderHook";
import { FilesPanel } from "./FilesPanel";
import type { TrackedProject } from "../projects";

const WORKTREE = "/repo/.worktrees/feature";

let root: Root | null = null;
let container: HTMLElement;
let cwd: string | null = WORKTREE;
let revealCwd: string | null | undefined;
let revealPath = `${WORKTREE}/src/worktree.ts`;
let revealNonce = 1;
let revealConsumed = false;
const readProjectDirs: Array<[string, string, string | undefined]> = [];
const readSessionDirs: Array<[string, string, string | undefined]> = [];
const readSessionFiles: Array<[string, string, string]> = [];
const readLocalFiles: string[] = [];
const consumedNonces: number[] = [];
let project: TrackedProject | undefined;
let engineSessionId: string | undefined;
let sessionMainRootId: string | undefined;

function reactPropsOf(node: unknown): Record<string, any> {
  const current = node as Record<string, any>;
  const key = Object.keys(current).find((name) => name.startsWith("__reactProps$"));
  return key ? current[key] : {};
}

function findElement(node: unknown, tagName: string): any {
  const current = node as { tagName?: string; childNodes?: unknown[] };
  if (current.tagName === tagName) return current;
  for (const child of current.childNodes ?? []) {
    const found = findElement(child, tagName);
    if (found) return found;
  }
  return undefined;
}

function findByProps(node: any, matches: (props: Record<string, any>) => boolean): any {
  if (matches(reactPropsOf(node))) return node;
  for (const child of node.childNodes ?? []) {
    const found = findByProps(child, matches);
    if (found) return found;
  }
  return undefined;
}

// Root selection remains a component contract here; real pointer/keyboard
// selection through the portaled menu is covered by the dropdown browser fixture.
function rootSelectProps(): Record<string, any> {
  const visit = (fiber: any): Record<string, any> | undefined => {
    if (!fiber) return undefined;
    if (fiber.type?.name === "SimpleSelect") return fiber.memoizedProps;
    return visit(fiber.child) ?? visit(fiber.sibling);
  };
  const current = (root as unknown as { _internalRoot: { current: unknown } })._internalRoot
    .current;
  const props = visit(current);
  if (!props) throw new Error("Expected the workspace root selector");
  return props;
}

function textOf(node: any): string {
  return node.nodeType === 3
    ? (node.nodeValue ?? node.textContent ?? "")
    : node.childNodes?.length
      ? node.childNodes.map(textOf).join("")
      : (node.textContent ?? "");
}

async function render(): Promise<void> {
  await act(async () => {
    root?.render(
      <FilesPanel
        cwd={cwd}
        project={project}
        engineSessionId={engineSessionId}
        sessionMainRootId={sessionMainRootId}
        revealFile={{
          path: revealPath,
          cwd: revealCwd === undefined ? cwd : revealCwd,
          nonce: revealNonce,
          consumed: revealConsumed,
        }}
        onRevealConsumed={(nonce) => consumedNonces.push(nonce)}
      />,
    );
    await flushMicrotasks();
  });
}

beforeEach(async () => {
  ensureMiniDom();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: () => null,
      setItem: () => undefined,
    },
  });
  readProjectDirs.length = 0;
  readSessionDirs.length = 0;
  readSessionFiles.length = 0;
  readLocalFiles.length = 0;
  consumedNonces.length = 0;
  revealCwd = undefined;
  project = {
    id: "project-1",
    name: "Project",
    path: "/repo",
    roots: [{ id: "primary", path: "/repo", name: "repo", addedAt: 1 }],
    primaryRootId: "primary",
    addedAt: 1,
  };
  engineSessionId = "session-1";
  sessionMainRootId = "primary";
  cwd = WORKTREE;
  revealPath = `${WORKTREE}/src/worktree.ts`;
  revealNonce = 1;
  revealConsumed = false;
  Object.assign(window, {
    codeshell: {
      readLocalFilePreview: async (path: string) => {
        readLocalFiles.push(path);
        return {
          path,
          text: "external file content",
          size: 21,
          ...(path.endsWith(".png") ? { imageDataUrl: "data:image/png;base64,AA==" } : {}),
        };
      },
      readProjectDir: async (projectId: string, rootId: string, dir?: string) => {
        readProjectDirs.push([projectId, rootId, dir]);
        return [];
      },
      readProjectFileContent: async () => ({ text: "content", size: 7 }),
      readSessionDir: async (sessionId: string, rootId: string, dir?: string) => {
        readSessionDirs.push([sessionId, rootId, dir]);
        return [];
      },
      readSessionFileContent: async (sessionId: string, rootId: string, path: string) => {
        readSessionFiles.push([sessionId, rootId, path]);
        return { text: "content", size: 7 };
      },
    },
  });
  container = document.createElement("div") as unknown as HTMLElement;
  root = createRoot(container);
  await render();
});

afterEach(async () => {
  await act(async () => {
    root?.unmount();
    await flushMicrotasks();
  });
  root = null;
});

describe("FilesPanel workspace identity", () => {
  test.each([
    ["win32", "C:\\owned\\repo", "C:\\owned\\repo\\报告 alpha.txt", "报告 alpha.txt"],
    ["win32", "\\\\owned-server\\share", "\\\\owned-server\\share\\alpha.txt", "alpha.txt"],
    ["linux", "/repo", "/repo/back\\slash.txt", "back\\slash.txt"],
    ["darwin", "/repo", "/repo/ 报告 alpha.txt ", " 报告 alpha.txt "],
  ])(
    "uses native file labels on %s while preserving the full comment locator",
    async (platform, directory, file, basename) => {
      window.codeshell.platform = platform;
      cwd = directory;
      project = {
        ...project!,
        path: directory,
        roots: [{ id: "primary", path: directory, name: "repo", addedAt: 1 }],
      };
      engineSessionId = undefined;
      sessionMainRootId = undefined;
      revealPath = file;
      revealNonce += 1;
      await render();

      const header = findByProps(
        container,
        (props) => props.className === "truncate text-sm font-medium text-foreground",
      );
      await act(async () => {
        const button = findByProps(container, (props) => props["aria-label"] === "评论此行");
        expect(button).toBeDefined();
        reactPropsOf(button).onClick({ currentTarget: button });
        await flushMicrotasks();
      });
      const textarea = findElement(container, "TEXTAREA");
      expect(reactPropsOf(textarea)["aria-label"]).toBe(`本地评论 · ${basename}:1`);
      expect(textOf(header)).toBe(basename);

      const anchors: any[] = [];
      const onAnchor = (event: Event) => anchors.push((event as CustomEvent).detail.anchor);
      window.addEventListener("codeshell:add-anchor", onAnchor);
      try {
        await act(async () => {
          reactPropsOf(textarea).onChange({ target: { value: "Owned comment" } });
          await flushMicrotasks();
        });
        await act(async () => {
          reactPropsOf(textarea).onKeyDown({
            key: "Enter",
            ctrlKey: true,
            nativeEvent: { isComposing: false },
            preventDefault() {},
          });
          await flushMicrotasks();
        });
        expect(anchors).toHaveLength(1);
        expect(anchors[0]).toMatchObject({
          kind: "file",
          label: `${basename}:1`,
          locator: { 文件: file, 行号: "1", 代码: "content" },
          comment: "Owned comment",
        });
        expect(findElement(container, "TEXTAREA")).toBeUndefined();
      } finally {
        window.removeEventListener("codeshell:add-anchor", onAnchor);
      }
    },
  );

  test.each([
    ["win32", "C:\\", "C:\\README.md", "C:\\"],
    ["linux", "/", "/README.md", "/"],
    ["linux", "/repo", "/repo/back\\slash.md", "/repo"],
  ])(
    "loads a Markdown image relative to the native file's directory on %s",
    async (platform, directory, file, expectedCwd) => {
      window.codeshell.platform = platform;
      const reads: Array<[string, { cwd?: string } | undefined]> = [];
      window.codeshell.readImageDataUrl = async (path, options) => {
        reads.push([path, options]);
        return "data:image/png;base64,AA==";
      };
      window.codeshell.readLocalFilePreview = async (path) => ({
        path,
        text: "![owned](owned.png)",
        size: 19,
      });
      cwd = null;
      project = undefined;
      engineSessionId = undefined;
      sessionMainRootId = undefined;
      revealCwd = directory;
      revealPath = file;
      revealNonce += 1;
      await render();
      expect(reads).toHaveLength(1);
      expect(reads[0][1]).toEqual({ cwd: expectedCwd });
      expect(reactPropsOf(findElement(container, "IMG")).src).toBe("data:image/png;base64,AA==");
    },
  );

  test("keeps an external reveal when switching workspaces from a secondary root", async () => {
    project = {
      ...project!,
      roots: [...project!.roots, { id: "secondary", path: "/other", name: "other", addedAt: 1 }],
    };
    revealConsumed = true;
    await render();
    await act(async () => {
      rootSelectProps().onChange("secondary");
      await flushMicrotasks();
    });

    cwd = "/repo/another-worktree";
    revealPath = "/outside/simultaneous.txt";
    revealNonce += 1;
    revealConsumed = false;
    await render();
    expect(readLocalFiles).toEqual([revealPath]);
    expect(textOf(container)).toContain("external file content");
    expect(findElement(container, "INPUT")).toBeUndefined();
    expect(consumedNonces.filter((nonce) => nonce === revealNonce)).toHaveLength(1);
  });

  test("previews an external file without a tree and restores the tree for a project file", async () => {
    readSessionDirs.length = 0;
    readSessionFiles.length = 0;
    revealPath = "/outside/notes.txt";
    revealNonce += 1;
    await render();

    expect(textOf(container)).toContain("external file content");
    expect(readLocalFiles).toEqual(["/outside/notes.txt"]);
    expect(readSessionFiles).toEqual([]);
    expect(readSessionDirs).toEqual([]);
    expect(findElement(container, "INPUT")).toBeUndefined();
    expect(consumedNonces.at(-1)).toBe(revealNonce);

    revealConsumed = true;
    await render();
    expect(textOf(container)).toContain("external file content");
    expect(findElement(container, "INPUT")).toBeUndefined();

    revealConsumed = false;
    revealPath = `${WORKTREE}/src/another.ts`;
    revealNonce += 1;
    await render();
    expect(findElement(container, "INPUT")).toBeDefined();
    expect(readSessionFiles.at(-1)).toEqual(["session-1", "primary", revealPath]);
    expect(readLocalFiles).toEqual(["/outside/notes.txt"]);
  });

  test("opens an absolute file when no project is selected", async () => {
    cwd = null;
    project = undefined;
    engineSessionId = undefined;
    sessionMainRootId = undefined;
    revealPath = "/outside/no-project.txt";
    revealNonce += 1;
    await render();

    expect(textOf(container)).toContain("external file content");
    expect(readLocalFiles).toEqual([revealPath]);
    expect(findElement(container, "INPUT")).toBeUndefined();
  });

  test("uses the clicked link's directory for relative file paths", async () => {
    revealCwd = "/outside/docs";
    revealPath = "notes.txt";
    revealNonce += 1;
    await render();
    expect(readLocalFiles).toEqual(["/outside/docs/notes.txt"]);
    expect(textOf(container)).toContain("external file content");
  });

  test("previews external images through the single-file reader", async () => {
    revealPath = "/outside/picture.png";
    revealNonce += 1;
    await render();
    expect(readLocalFiles).toEqual([revealPath]);
    expect(reactPropsOf(findElement(container, "IMG")).src).toBe("data:image/png;base64,AA==");
    expect(findElement(container, "INPUT")).toBeUndefined();
  });

  test("renders external Markdown as a document", async () => {
    window.codeshell.readLocalFilePreview = async (path) => ({
      path,
      text: "# External document\n\nReadable outside the project.",
      size: 50,
    });
    revealPath = "/outside/document.md";
    revealNonce += 1;
    await render();
    expect(textOf(findElement(container, "H1"))).toBe("External document");
    expect(textOf(container)).toContain("Readable outside the project.");
    expect(findElement(container, "INPUT")).toBeUndefined();
  });

  test("keeps a manually hidden tree hidden after previewing an external file", async () => {
    // Find the actual visibility action; the tree has its own refresh control.
    const findHideTree = (node: any): any => {
      if (reactPropsOf(node)["aria-label"] === "隐藏文件树") return node;
      for (const child of node.childNodes ?? []) {
        const found = findHideTree(child);
        if (found) return found;
      }
      return undefined;
    };
    await act(async () => {
      reactPropsOf(findHideTree(container)).onClick();
      await flushMicrotasks();
    });
    expect(findElement(container, "INPUT")).toBeUndefined();
    revealPath = "/outside/notes.txt";
    revealNonce += 1;
    await render();
    revealPath = `${WORKTREE}/src/another.ts`;
    revealNonce += 1;
    await render();
    expect(findElement(container, "INPUT")).toBeUndefined();
    expect(readSessionFiles.at(-1)).toEqual(["session-1", "primary", revealPath]);
  });

  test("shows failed external reads and retries when the same link is clicked again", async () => {
    window.codeshell.readLocalFilePreview = async () => {
      throw new Error("file no longer exists");
    };
    revealPath = "/outside/missing.txt";
    revealNonce += 1;
    await render();
    expect(textOf(container)).toContain("file no longer exists");
    expect(consumedNonces.at(-1)).toBe(revealNonce);

    window.codeshell.readLocalFilePreview = async () => ({
      path: revealPath,
      text: "restored external file",
      size: 22,
    });
    revealNonce += 1;
    await render();
    expect(textOf(container)).toContain("restored external file");
    expect(textOf(container)).not.toContain("file no longer exists");
  });

  test("a successful same-file refresh recovers a failed preview read", async () => {
    const text = (node: any): string =>
      node.nodeType === 3
        ? (node.nodeValue ?? node.textContent ?? "")
        : node.childNodes?.length
          ? node.childNodes.map(text).join("")
          : (node.textContent ?? "");
    window.codeshell.readSessionFileContent = async () => {
      throw new Error("temporary file error");
    };
    await act(async () => {
      window.dispatchEvent(new Event("codeshell:files-changed"));
      await flushMicrotasks();
    });
    expect(text(container)).toContain("temporary file error");

    window.codeshell.readSessionFileContent = async () => ({
      text: "recovered file content",
      size: 22,
    });
    await act(async () => {
      window.dispatchEvent(new Event("codeshell:files-changed"));
      await flushMicrotasks();
    });
    expect(text(container)).toContain("recovered file content");
    expect(text(container)).not.toContain("temporary file error");
  });

  test("uses the resolved root for fs and clears a nested-worktree selection when returning to main", async () => {
    expect(readSessionDirs).toContainEqual(["session-1", "primary", WORKTREE]);
    expect(readSessionFiles).toContainEqual([
      "session-1",
      "primary",
      `${WORKTREE}/src/worktree.ts`,
    ]);

    readSessionFiles.length = 0;
    revealConsumed = true;
    cwd = "/repo";
    await render();

    expect(readSessionFiles).toEqual([]);
  });

  test("clears a main selection when switching into a nested worktree", async () => {
    cwd = "/repo";
    revealPath = "/repo/src/main.ts";
    revealNonce = 2;
    await render();
    expect(readSessionFiles.at(-1)).toEqual(["session-1", "primary", "/repo/src/main.ts"]);

    readSessionFiles.length = 0;
    revealConsumed = true;
    cwd = WORKTREE;
    await render();

    expect(readSessionFiles).toEqual([]);
  });

  test("shows secondary roots and reads them through projectId/rootId authorization", async () => {
    project = {
      id: "project-1",
      name: "Project",
      path: "/repo",
      roots: [
        { id: "primary", path: "/repo", name: "repo", addedAt: 1 },
        { id: "secondary", path: "/shared", name: "shared", addedAt: 2 },
      ],
      primaryRootId: "primary",
      addedAt: 1,
    };
    cwd = "/repo";
    engineSessionId = undefined;
    sessionMainRootId = undefined;
    revealConsumed = true;
    await render();

    const select = rootSelectProps();
    expect(select.options.map((option: { value: string }) => option.value)).toContain("secondary");
    await act(async () => {
      select.onChange("secondary");
      await flushMicrotasks();
    });

    expect(readProjectDirs).toContainEqual(["project-1", "secondary", "/shared"]);
  });

  test("uses the Session mainRootId for a worktree after Make primary without duplicating the old root", async () => {
    project = {
      id: "project-1",
      name: "Project",
      path: "/notes",
      roots: [
        { id: "old-main", path: "/repo", name: "repo", addedAt: 1 },
        { id: "new-primary", path: "/notes", name: "notes", addedAt: 2 },
      ],
      primaryRootId: "new-primary",
      addedAt: 1,
    };
    cwd = WORKTREE;
    engineSessionId = "old-session";
    sessionMainRootId = "old-main";
    revealConsumed = true;
    await render();

    expect(readSessionDirs).toContainEqual(["old-session", "old-main", WORKTREE]);
    const select = rootSelectProps();
    const optionValues = select.options.map((option: { value: string }) => option.value);
    expect(optionValues).toEqual(["old-main", "new-primary"]);

    await act(async () => {
      select.onChange("new-primary");
      await flushMicrotasks();
    });
    expect(readSessionDirs).toContainEqual(["old-session", "new-primary", "/notes"]);
    expect(readProjectDirs).toEqual([]);
  });
});
