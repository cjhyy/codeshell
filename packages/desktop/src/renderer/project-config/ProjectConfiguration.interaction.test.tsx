import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ensureMiniDom, flushMicrotasks } from "../test-utils/renderHook";
import { SettingsPage } from "../settings/SettingsPage";
import { ProjectOverviewSection } from "../settings/ProjectOverviewSection";
import { ProjectInstructionsSection } from "./ProjectInstructionsSection";

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
function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

describe("project configuration presentation", () => {
  let root: Root;
  let container: HTMLElement;
  let storageBefore: PropertyDescriptor | undefined;
  let apiBefore: PropertyDescriptor | undefined;
  let readFailure: string | null;
  let existing: boolean;
  const reads: Array<[string, string, string]> = [];
  const opens: Array<{ file: string; cwd: string; pending: ReturnType<typeof deferred> }> = [];

  beforeEach(() => {
    ensureMiniDom();
    storageBefore = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    apiBefore = Object.getOwnPropertyDescriptor(window, "codeshell");
    const storage = new Map<string, string>();
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value),
      },
    });
    readFailure = null;
    existing = false;
    reads.length = 0;
    opens.length = 0;
    Object.defineProperty(window, "codeshell", {
      configurable: true,
      value: {
        projectFileExists: async (projectId: string, rootId: string, file: string) => {
          reads.push([projectId, rootId, file]);
          if (readFailure) throw new Error(readFailure);
          return existing;
        },
        openInEditor: (file: string, cwd: string) => {
          const pending = deferred();
          opens.push({ file, cwd, pending });
          return pending.promise;
        },
      },
    });
    container = document.createElement("div");
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
  });

  const nodes = () => descendants(container);
  const button = (label: string) =>
    nodes().find(
      (node) => node.tagName === "BUTTON" && (props(node)["aria-label"] ?? textOf(node)) === label,
    ) as HTMLButtonElement;
  const render = async (node: React.ReactNode) => {
    await act(async () => {
      root.render(node);
      await flushMicrotasks();
    });
  };
  const instructions = (projectId = "repo", cwd = "/repo") =>
    render(
      <ProjectInstructionsSection projectId={projectId} rootId={`${projectId}-root`} cwd={cwd} />,
    );
  const click = async (node: HTMLElement) => {
    node.focus();
    await act(async () => {
      props(node).onClick();
      await flushMicrotasks();
    });
  };
  const finishOpen = async (index: number, error?: string) => {
    await act(async () => {
      if (error) opens[index].pending.reject(new Error(error));
      else opens[index].pending.resolve();
      await flushMicrotasks();
    });
  };

  test("groups project-only destinations and focuses the selected module heading", async () => {
    await render(
      <SettingsPage
        initialProjectPath="/repo"
        initialModule="project-overview"
        activeProjectPath="/repo"
        projects={[
          { id: "repo", primaryRootId: "repo-root", path: "/repo", name: "Project", addedAt: 1 },
        ]}
        sessionIndices={{}}
        onRestoreArchivedSession={() => undefined}
        onDeleteArchivedSession={() => undefined}
        isMac={false}
        isFullscreen={false}
        onBack={() => undefined}
      />,
    );
    const overview = nodes().find(
      (node) => node.tagName === "NAV" && props(node)["aria-label"] === "项目配置模块",
    )!;
    expect(
      descendants(overview)
        .filter((node) => node.tagName === "H2")
        .map(textOf),
    ).toEqual(["基础设置5", "扩展能力4", "环境与连接2"]);
    expect(textOf(overview)).not.toContain("外观");
    expect(textOf(overview)).not.toContain("键盘快捷键");
    const instructionsButton = descendants(overview).find(
      (node) => node.tagName === "BUTTON" && textOf(node) === "指令文件",
    ) as HTMLElement;
    expect(props(instructionsButton).type).toBe("button");
    await click(instructionsButton);
    const heading = nodes().find((node) => node.tagName === "H1")!;
    expect(textOf(heading)).toBe("指令文件");
    expect(document.activeElement === heading).toBe(true);
    expect(
      nodes().some(
        (node) =>
          node.tagName === "BUTTON" &&
          props(node)["aria-current"] === "page" &&
          textOf(node) === "指令文件",
      ),
    ).toBe(true);
    expect(reads).toEqual(
      ["CODESHELL.md", "CLAUDE.md", "AGENTS.md"].map((file) => ["repo", "repo-root", file]),
    );
  });

  test("shows an explicit empty state when no project destinations are available", async () => {
    await render(
      <ProjectOverviewSection
        groups={[{ title: "Empty", modules: [] }]}
        onSelect={() => undefined}
      />,
    );
    expect(textOf(container)).toContain("当前项目没有可用的配置项");
    expect(nodes().some((node) => props(node).role === "status")).toBe(true);
    expect(nodes().filter((node) => node.tagName === "BUTTON")).toHaveLength(0);
  });

  test("failed file checks stop loading and retry without opening or creating anything", async () => {
    readFailure = "synthetic read failure";
    await instructions();
    expect(textOf(container)).toContain("无法检查指令文件：synthetic read failure");
    expect(textOf(container)).toContain("尚未确认文件状态");
    expect(textOf(container)).not.toContain("正在检查");
    for (const file of ["CODESHELL.md", "CLAUDE.md", "AGENTS.md"])
      expect(props(button(`在编辑器打开 ${file}`)).disabled).toBe(true);
    readFailure = null;
    const retry = button("重新检查");
    await click(retry);
    expect(reads).toHaveLength(6);
    expect(textOf(container)).not.toContain("synthetic read failure");
    expect(document.activeElement === retry).toBe(true);
    expect(props(button("创建并打开 CODESHELL.md")).disabled).toBe(false);
    expect(opens).toHaveLength(0);
  });

  test("names each file action, deduplicates opening, and keeps a failed action retryable", async () => {
    await instructions();
    const create = button("创建并打开 CODESHELL.md");
    await click(create);
    await click(create);
    expect(opens).toHaveLength(1);
    expect([opens[0].file, opens[0].cwd]).toEqual(["CODESHELL.md", "/repo"]);
    await finishOpen(0, "editor unavailable");
    expect(textOf(container)).toContain("无法打开 CODESHELL.md：editor unavailable");
    expect(props(create).disabled).toBe(false);
    await click(create);
    existing = true;
    await finishOpen(1);
    expect(opens).toHaveLength(2);
    expect(textOf(container)).not.toContain("editor unavailable");
    expect(button("在编辑器打开 CODESHELL.md")).toBeDefined();
    expect(reads.at(-1)).toEqual(["repo", "repo-root", "CODESHELL.md"]);
  });

  test("an old project's pending editor failure cannot overwrite the new project's status", async () => {
    await instructions();
    await click(button("创建并打开 CODESHELL.md"));
    existing = true;
    await instructions("other", "/other");
    const readsBeforeOldCompletion = reads.length;
    await finishOpen(0, "old editor error");
    expect(textOf(container)).not.toContain("old editor error");
    expect(reads).toHaveLength(readsBeforeOldCompletion);
    expect(props(button("在编辑器打开 CODESHELL.md")).disabled).toBe(false);
    await click(button("在编辑器打开 CODESHELL.md"));
    expect([opens[1].file, opens[1].cwd]).toEqual(["CODESHELL.md", "/other"]);
    await finishOpen(1);
    expect(reads.at(-1)).toEqual(["other", "other-root", "CODESHELL.md"]);
  });
});
