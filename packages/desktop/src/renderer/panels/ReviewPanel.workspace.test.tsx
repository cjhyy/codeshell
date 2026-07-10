import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { GitCommit } from "../../preload/types";
import { ensureMiniDom, flushMicrotasks } from "../test-utils/renderHook";

let openCommitMenu: (() => void) | null = null;
const diffCwds: string[] = [];

function childText(value: React.ReactNode): string {
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map(childText).join("");
  if (React.isValidElement<{ children?: React.ReactNode }>(value)) {
    return childText(value.props.children);
  }
  return "";
}

mock.module("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuTrigger: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuContent: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuItem: ({ children, onSelect }: any) => (
    <button data-label={childText(children)} onClick={onSelect}>{children}</button>
  ),
  DropdownMenuSub: ({ children, onOpenChange }: any) => {
    openCommitMenu = () => onOpenChange(true);
    return <div>{children}</div>;
  },
  DropdownMenuSubTrigger: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuSubContent: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
}));
mock.module("@/components/ui/simple-select", () => ({ SimpleSelect: () => null }));
mock.module("../diff/UnifiedDiffViewer", () => ({
  UnifiedDiffViewer: ({ cwd }: { cwd: string }) => {
    diffCwds.push(cwd);
    return <div data-diff-cwd={cwd} />;
  },
}));

const { ReviewPanel } = await import("./ReviewPanel");

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function labels(node: unknown): string[] {
  const current = node as { attributes?: Map<string, string>; childNodes?: unknown[] };
  const own = current.attributes?.get("data-label");
  return [...(own ? [own] : []), ...(current.childNodes ?? []).flatMap(labels)];
}

let root: Root | null = null;
let container: HTMLElement;
let cwd = "/repo-a";
let requests: Record<string, ReturnType<typeof deferred<GitCommit[]>>>;

async function render(): Promise<void> {
  await act(async () => {
    root?.render(<ReviewPanel cwd={cwd} />);
    await flushMicrotasks();
  });
}

beforeEach(async () => {
  ensureMiniDom();
  diffCwds.length = 0;
  openCommitMenu = null;
  cwd = "/repo-a";
  requests = {
    "/repo-a": deferred<GitCommit[]>(),
    "/repo-b": deferred<GitCommit[]>(),
  };
  Object.assign(window, {
    codeshell: {
      getGitRecentCommits: (rootPath: string) => requests[rootPath]!.promise,
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

describe("ReviewPanel workspace requests", () => {
  test("keeps git on the current root and ignores an older commit response", async () => {
    expect(diffCwds.at(-1)).toBe("/repo-a");
    openCommitMenu?.();

    cwd = "/repo-b";
    await render();
    expect(diffCwds.at(-1)).toBe("/repo-b");
    openCommitMenu?.();

    await act(async () => {
      requests["/repo-b"]!.resolve([
        { hash: "bbbb", subject: "B commit", author: "B", relativeDate: "now" },
      ]);
      await flushMicrotasks();
    });
    expect(labels(container)).toContain("B commitnow");

    await act(async () => {
      requests["/repo-a"]!.resolve([
        { hash: "aaaa", subject: "A stale commit", author: "A", relativeDate: "old" },
      ]);
      await flushMicrotasks();
    });

    expect(labels(container)).toContain("B commitnow");
    expect(labels(container)).not.toContain("A stale commitold");
  });
});
