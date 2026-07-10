import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ensureMiniDom, flushMicrotasks } from "../test-utils/renderHook";
import { FilesPanel } from "./FilesPanel";

const WORKTREE = "/repo/.worktrees/feature";

let root: Root | null = null;
let container: HTMLElement;
let cwd = WORKTREE;
let revealPath = `${WORKTREE}/src/worktree.ts`;
let revealNonce = 1;
let revealConsumed = false;
const readDirs: Array<[string, string]> = [];
const readFiles: Array<[string, string]> = [];

async function render(): Promise<void> {
  await act(async () => {
    root?.render(
      <FilesPanel
        cwd={cwd}
        revealFile={{ path: revealPath, cwd, nonce: revealNonce, consumed: revealConsumed }}
      />,
    );
    await flushMicrotasks();
  });
}

beforeEach(async () => {
  ensureMiniDom();
  Object.assign(globalThis, {
    localStorage: {
      getItem: () => null,
      setItem: () => undefined,
    },
  });
  readDirs.length = 0;
  readFiles.length = 0;
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
});
