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
const readDirs: Array<[string, string]> = [];
const readFiles: Array<[string, string]> = [];
const readProjectDirs: Array<[string, string, string | undefined]> = [];
let project: TrackedProject | undefined;

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
  readDirs.length = 0;
  readFiles.length = 0;
  readProjectDirs.length = 0;
  project = undefined;
  cwd = WORKTREE;
  revealPath = `${WORKTREE}/src/worktree.ts`;
  revealNonce = 1;
  revealConsumed = false;
  Object.assign(window, {
    codeshell: {
      readDir: async (rootPath: string, dir: string) => {
        readDirs.push([rootPath, dir]);
        return [];
      },
      readFileContent: async (rootPath: string, path: string) => {
        readFiles.push([rootPath, path]);
        return { text: "content", reason: null, truncated: false };
      },
      readProjectDir: async (projectId: string, rootId: string, dir?: string) => {
        readProjectDirs.push([projectId, rootId, dir]);
        return [];
      },
      readProjectFileContent: async () => ({ text: "content", size: 7 }),
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
    expect(readDirs).toContainEqual([WORKTREE, WORKTREE]);
    expect(readFiles).toContainEqual([WORKTREE, `${WORKTREE}/src/worktree.ts`]);

    readFiles.length = 0;
    revealConsumed = true;
    cwd = "/repo";
    await render();

    expect(readFiles).toEqual([]);
  });

  test("clears a main selection when switching into a nested worktree", async () => {
    cwd = "/repo";
    revealPath = "/repo/src/main.ts";
    revealNonce = 2;
    await render();
    expect(readFiles.at(-1)).toEqual(["/repo", "/repo/src/main.ts"]);

    readFiles.length = 0;
    revealConsumed = true;
    cwd = WORKTREE;
    await render();

    expect(readFiles).toEqual([]);
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
});
