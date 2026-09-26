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
  test("keeps an external reveal when switching workspaces from a secondary root", async () => {
    project = {
      ...project!,
      roots: [...project!.roots, { id: "secondary", path: "/other", name: "other", addedAt: 1 }],
    };
    revealConsumed = true;
    await render();
    await act(async () => {
      reactPropsOf(findElement(container, "SELECT")).onChange({ target: { value: "secondary" } });
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
    // The first button is the tree visibility control in the panel toolbar.
    await act(async () => {
      reactPropsOf(findElement(container, "BUTTON")).onClick();
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

    const select = findElement(container, "SELECT");
    expect(select).toBeDefined();
    await act(async () => {
      reactPropsOf(select).onChange({ target: { value: "secondary" } });
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
    const select = findElement(container, "SELECT");
    const optionValues = (select?.childNodes ?? []).map(
      (option: unknown) => reactPropsOf(option).value,
    );
    expect(optionValues).toEqual(["old-main", "new-primary"]);

    await act(async () => {
      reactPropsOf(select).onChange({ target: { value: "new-primary" } });
      await flushMicrotasks();
    });
    expect(readSessionDirs).toContainEqual(["old-session", "new-primary", "/notes"]);
    expect(readProjectDirs).toEqual([]);
  });
});
