import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import React, { act, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { GitBranches } from "../../preload/types";
import { ensureMiniDom, flushMicrotasks } from "../test-utils/renderHook";
import { BranchPicker } from "./BranchPicker";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function descendants(node: Element): Element[] {
  return [node, ...Array.from(node.children).flatMap(descendants)];
}

function textOf(node: Node): string {
  if (node.nodeType === 3) return node.nodeValue ?? "";
  const children = Array.from(node.childNodes);
  return children.length ? children.map(textOf).join("") : (node.textContent ?? "");
}

function props(node: Element): Record<string, any> {
  const key = Object.keys(node).find((name) => name.startsWith("__reactProps$"));
  return key ? (node as unknown as Record<string, any>)[key] : {};
}

const repo = (current: string | null = "main"): GitBranches => ({
  isRepo: true,
  current,
  branches: ["main", "feature"],
});

describe("BranchPicker context visibility", () => {
  let root: Root;
  let container: HTMLElement;
  let storageBefore: PropertyDescriptor | undefined;
  let apiBefore: PropertyDescriptor | undefined;
  const windowBefore = new Map<string, PropertyDescriptor | undefined>();
  let elementPrototype: object;
  const layoutBefore = new Map<string, PropertyDescriptor | undefined>();
  let status: () => Promise<{ clean: boolean }>;
  const reads: Array<{ projectId: string; pending: ReturnType<typeof deferred<GitBranches>> }> = [];
  const switches: Array<{
    projectId: string;
    branch: string;
    pending: ReturnType<typeof deferred<GitBranches>>;
  }> = [];
  const commits: string[] = [];

  function CommitProbe() {
    useLayoutEffect(() => {
      commits.push(textOf(container));
    });
    return null;
  }

  beforeEach(() => {
    ensureMiniDom();
    storageBefore = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    apiBefore = Object.getOwnPropertyDescriptor(window, "codeshell");
    for (const [key, value] of Object.entries({
      requestAnimationFrame: () => 0,
      cancelAnimationFrame: () => undefined,
      innerWidth: 1_024,
      innerHeight: 800,
    })) {
      windowBefore.set(key, Object.getOwnPropertyDescriptor(window, key));
      Object.defineProperty(window, key, { configurable: true, value });
    }
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: { getItem: () => null, setItem: () => undefined },
    });
    reads.length = 0;
    switches.length = 0;
    commits.length = 0;
    status = async () => ({ clean: true });
    Object.defineProperty(window, "codeshell", {
      configurable: true,
      value: {
        getProjectGitBranches: (projectId: string) => {
          const pending = deferred<GitBranches>();
          reads.push({ projectId, pending });
          return pending.promise;
        },
        getProjectGitStatus: () => status(),
        switchProjectGitBranch: (projectId: string, branch: string) => {
          const pending = deferred<GitBranches>();
          switches.push({ projectId, branch, pending });
          return pending.promise;
        },
      },
    });
    container = document.createElement("div");
    elementPrototype = Object.getPrototypeOf(container);
    for (const [key, value] of Object.entries({ offsetWidth: 288, offsetHeight: 160 })) {
      layoutBefore.set(key, Object.getOwnPropertyDescriptor(elementPrototype, key));
      Object.defineProperty(elementPrototype, key, { configurable: true, value });
    }
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
      await flushMicrotasks();
    });
    document.body.removeChild(container);
    if (storageBefore) Object.defineProperty(globalThis, "localStorage", storageBefore);
    else Reflect.deleteProperty(globalThis, "localStorage");
    if (apiBefore) Object.defineProperty(window, "codeshell", apiBefore);
    else Reflect.deleteProperty(window, "codeshell");
    for (const [key, descriptor] of windowBefore) {
      if (descriptor) Object.defineProperty(window, key, descriptor);
      else Reflect.deleteProperty(window, key);
    }
    windowBefore.clear();
    for (const [key, descriptor] of layoutBefore) {
      if (descriptor) Object.defineProperty(elementPrototype, key, descriptor);
      else Reflect.deleteProperty(elementPrototype, key);
    }
    layoutBefore.clear();
  });

  const render = async (projectId: string | null, cwd: string | null) => {
    await act(async () => {
      root.render(
        <>
          <BranchPicker projectId={projectId} cwd={cwd} />
          <CommitProbe />
        </>,
      );
      await flushMicrotasks();
    });
  };
  const settle = async (index: number, value: GitBranches | Error) => {
    await act(async () => {
      if (value instanceof Error) reads[index]!.pending.reject(value);
      else reads[index]!.pending.resolve(value);
      await flushMicrotasks();
    });
  };
  const buttons = () => descendants(container).filter((node) => node.tagName === "BUTTON");
  const click = async (node: Element) => {
    await act(async () => {
      props(node).onClick();
      await flushMicrotasks();
    });
  };
  const chooseFeature = async () => {
    const anchor = buttons()[0]!;
    // The shared mini DOM has no layout engine; provide this anchor's bounds
    // while still exercising the real popover and its branch click handlers.
    Object.assign(anchor, {
      getBoundingClientRect: () => ({ top: 400, bottom: 432, left: 40, right: 160 }),
    });
    await click(anchor);
    const item = descendants(container).find(
      (node) => node.tagName === "LI" && textOf(node) === "feature",
    );
    expect(item).toBeDefined();
    await click(item!);
  };

  test("renders nothing without a project, while unconfirmed, for non-Git, or after a failed probe", async () => {
    await render(null, null);
    expect(buttons()).toHaveLength(0);
    expect(reads).toHaveLength(0);

    await render("notes", "/notes");
    expect(buttons()).toHaveLength(0);
    await settle(0, { isRepo: false, current: null, branches: [] });
    expect(buttons()).toHaveLength(0);
    expect(textOf(container)).toBe("");

    await render("unavailable", "/unavailable");
    expect(buttons()).toHaveLength(0);
    await settle(1, new Error("Git lookup failed"));
    expect(buttons()).toHaveLength(0);
  });

  test.each([
    { name: "normal", value: repo(), label: "main", disabled: false },
    {
      name: "unborn",
      value: { isRepo: true, current: null, branches: [] },
      label: "无本地分支",
      disabled: true,
    },
    { name: "detached", value: repo(null), label: "detached HEAD", disabled: false },
  ])("keeps $name Git repositories visible", async ({ value, label, disabled }) => {
    await render("repo", "/repo");
    await settle(0, value);
    expect(buttons()).toHaveLength(1);
    expect(textOf(buttons()[0]!)).toBe(label);
    expect(props(buttons()[0]!).disabled).toBe(disabled);
  });

  test.each(["project", "workspace"] as const)(
    "hides stale labels before effects on %s changes and ignores late probes",
    async (change) => {
      await render("project-a", "/repo-a");
      await settle(0, repo("old-branch"));
      commits.length = 0;

      const nextProject = change === "project" ? "project-b" : "project-a";
      await render(nextProject, "/repo-b");
      expect(commits.length).toBeGreaterThan(0);
      expect(commits.every((text) => !text.includes("old-branch"))).toBe(true);
      expect(buttons()).toHaveLength(0);

      await render("project-c", "/repo-c");
      await settle(2, repo("current-branch"));
      await settle(1, repo("late-branch"));
      expect(textOf(container)).toBe("current-branch");
    },
  );

  test("does not start an old project's branch switch after its status probe completes", async () => {
    const pendingStatus = deferred<{ clean: boolean }>();
    status = () => pendingStatus.promise;
    await render("project-a", "/repo-a");
    await settle(0, repo());
    await chooseFeature();

    await render("project-b", "/repo-b");
    await settle(1, repo("project-b-main"));
    await act(async () => {
      pendingStatus.resolve({ clean: true });
      await flushMicrotasks();
    });
    expect(switches).toHaveLength(0);
    expect(textOf(container)).toBe("project-b-main");
  });

  test("an in-flight switch cannot overwrite a newly selected project's branch", async () => {
    await render("project-a", "/repo-a");
    await settle(0, repo());
    await chooseFeature();
    expect(switches).toHaveLength(1);
    expect(switches[0]!.projectId).toBe("project-a");
    expect(switches[0]!.branch).toBe("feature");

    await render("project-b", "/repo-b");
    await settle(1, repo("project-b-main"));
    await act(async () => {
      switches[0]!.pending.resolve(repo("feature"));
      await flushMicrotasks();
    });
    expect(textOf(container)).toBe("project-b-main");
  });
});
