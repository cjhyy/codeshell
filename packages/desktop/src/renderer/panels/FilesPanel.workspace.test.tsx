import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ensureMiniDom, flushMicrotasks } from "../test-utils/renderHook";
import { FilesPanel } from "./FilesPanel";
import type { TrackedProject } from "../projects";

const WORKTREE = "/repo/.worktrees/feature";

let root: Root | null = null;
let container: HTMLElement;
let cwd = WORKTREE;
let revealPath = `${WORKTREE}/src/worktree.ts`;
let revealNonce = 1;
let revealConsumed = false;
const readProjectDirs: Array<[string, string, string | undefined]> = [];
const readSessionDirs: Array<[string, string, string | undefined]> = [];
const readSessionFiles: Array<[string, string, string]> = [];
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

async function render(): Promise<void> {
  await act(async () => {
    root?.render(
      <FilesPanel
        cwd={cwd}
        project={project}
        engineSessionId={engineSessionId}
        sessionMainRootId={sessionMainRootId}
        revealFile={{ path: revealPath, cwd, nonce: revealNonce, consumed: revealConsumed }}
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
