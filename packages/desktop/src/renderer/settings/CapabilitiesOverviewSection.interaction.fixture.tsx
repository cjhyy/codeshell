import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { PanelAppExtensionSummary } from "../../preload/types";
import { loadProjects, saveProjects, type TrackedProject } from "../projects";
import { ensureMiniDom, flushMicrotasks } from "../test-utils/renderHook";

ensureMiniDom();
const { CapabilitiesOverviewSection } = await import("./CapabilitiesOverviewSection");

function nodes(node: any): any[] {
  return [node, ...Array.from(node.childNodes ?? []).flatMap(nodes)];
}

function textOf(node: any): string {
  if (node.nodeType === 3) return node.nodeValue ?? node.data ?? "";
  const children = Array.from(node.childNodes ?? []);
  return children.length ? children.map(textOf).join("") : (node.textContent ?? "");
}

function props(node: any): Record<string, any> {
  const key = Object.keys(node).find((name) => name.startsWith("__reactProps$"));
  return key ? node[key] : {};
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function panel(path: string): PanelAppExtensionSummary {
  const alpha = path.endsWith("alpha");
  return {
    id: "panel-app:fixture-panel",
    appId: "fixture-panel",
    title: "项目文档面板",
    // This is the project's retained package, independently of the catalog's
    // newer 9.0.0 release. No catalog API should substitute its permissions.
    version: alpha ? "1.4.0" : "2.1.0",
    revision: alpha ? "alpha-package" : "beta-package",
    bindingRevision: (alpha ? "a" : "b").repeat(64),
    hostId: "fixture-panel",
    kind: "panel-app",
    icon: "panel",
    singleton: true,
    permissions: alpha ? ["workspace.read"] : ["process", "storage"],
    agent: {
      tools: [
        {
          name: alpha ? "read_selected_document" : "write_selected_document",
          description: alpha ? "读取 Alpha 项目已授权的文档。" : "保存 Beta 项目已确认的文档。",
          inputSchema: { type: "object" },
          readOnly: alpha,
        },
      ],
      skills: [alpha ? "skills/alpha-reader/SKILL.md" : "skills/beta-writer/SKILL.md"],
    },
    projectBound: true,
    enabled: true,
    updateSource: { kind: "git", label: "fixtures/panels", available: true },
  };
}

describe("project Panel capability details", () => {
  let root: Root;
  let container: HTMLElement;
  let savedBridge: PropertyDescriptor | undefined;
  let savedStorage: PropertyDescriptor | undefined;
  let savedProjects: TrackedProject[];
  let panelReads: Array<[string, string]>;
  let bindings: unknown[];
  let readPanels: (cwd: string) => Promise<PanelAppExtensionSummary[]>;

  beforeEach(() => {
    savedBridge = Object.getOwnPropertyDescriptor(window, "codeshell");
    savedStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    savedProjects = loadProjects();
    saveProjects(
      ["alpha", "beta"].map((name) => ({
        id: `capability-${name}`,
        name,
        path: `/tmp/capability-${name}`,
        roots: [
          {
            id: `root-${name}`,
            path: `/tmp/capability-${name}`,
            name,
            addedAt: 1,
          },
        ],
        primaryRootId: `root-${name}`,
        addedAt: 1,
      })),
    );
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: { getItem: () => null, setItem: () => undefined },
    });
    panelReads = [];
    bindings = [];
    readPanels = async (cwd) => [panel(cwd)];
    Object.defineProperty(window, "codeshell", {
      configurable: true,
      value: {
        listCapabilities: async () => [],
        listPanelAppExtensions: async (cwd: string, locale: string) => {
          panelReads.push([cwd, locale]);
          return readPanels(cwd);
        },
        listPanelApps: () => {
          throw new Error("The global catalog must not replace the selected project package");
        },
        setPanelAppProjectBinding: async (...args: unknown[]) => {
          bindings.push(args);
          return [];
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
    saveProjects(savedProjects);
    if (savedBridge) Object.defineProperty(window, "codeshell", savedBridge);
    else Reflect.deleteProperty(window, "codeshell");
    if (savedStorage) Object.defineProperty(globalThis, "localStorage", savedStorage);
    else Reflect.deleteProperty(globalThis, "localStorage");
  });

  async function render(scope: "user" | "project" = "project", name = "alpha") {
    await act(async () => {
      root.render(
        <CapabilitiesOverviewSection
          scope={scope}
          projectPath={scope === "project" ? `/tmp/capability-${name}` : null}
          projectLabel={name}
        />,
      );
      await flushMicrotasks();
    });
  }

  function button(label: string) {
    const node = nodes(container).find(
      (candidate) =>
        candidate.tagName === "BUTTON" &&
        (textOf(candidate) === label ||
          (props(candidate)["aria-controls"] && textOf(candidate).startsWith(label))),
    );
    expect(node).toBeDefined();
    return node;
  }

  async function click(node: any) {
    await act(async () => {
      props(node).onClick();
      await flushMicrotasks();
    });
  }

  test("the selected package exposes its version, readable Host authority, tools, and Skill paths", async () => {
    await render();
    expect(panelReads).toEqual([["/tmp/capability-alpha", "zh"]]);
    expect(textOf(container)).toContain("v1.4.0");
    expect(textOf(container)).not.toContain("v9.0.0");
    const disclosure = button("能力详情");
    expect(props(disclosure)["aria-expanded"]).toBe(false);
    expect(textOf(container)).not.toContain("read_selected_document");
    await click(disclosure);
    expect(props(disclosure)["aria-expanded"]).toBe(true);
    const details = textOf(container);
    expect(details).toContain("声明的 Host 能力");
    expect(details).toContain("workspace.read");
    expect(details).toContain("读取项目文件");
    expect(details).toContain("列出、读取和打开允许范围内的项目文件。");
    expect(details).not.toContain("credentials.connections");
    expect(details).toContain("read_selected_document");
    expect(details).toContain("读取 Alpha 项目已授权的文档。");
    expect(details).toContain("只读");
    expect(details).toContain("skills/alpha-reader/SKILL.md");
    expect(bindings).toEqual([]);
    await click(disclosure);
    expect(textOf(container)).not.toContain("read_selected_document");
  });

  test("switching projects replaces the package details and keeps binding authority scoped", async () => {
    await render();
    await click(button("能力详情"));
    await render("project", "beta");
    expect(panelReads.at(-1)).toEqual(["/tmp/capability-beta", "zh"]);
    expect(textOf(container)).toContain("v2.1.0");
    expect(textOf(container)).not.toContain("v1.4.0");
    const disclosure = button("能力详情");
    if (!props(disclosure)["aria-expanded"]) await click(disclosure);
    expect(textOf(container)).toContain("process");
    expect(textOf(container)).toContain("write_selected_document");
    expect(textOf(container)).toContain("保存 Beta 项目已确认的文档。");
    expect(textOf(container)).toContain("skills/beta-writer/SKILL.md");
    expect(textOf(container)).not.toContain("workspace.read");
    expect(textOf(container)).not.toContain("read_selected_document");
    expect(bindings).toEqual([]);
  });

  test("user scope does not show a project's Panel authority", async () => {
    await render();
    await click(button("能力详情"));
    await render("user");
    expect(panelReads).toHaveLength(1);
    expect(textOf(container)).not.toContain("项目文档面板");
    expect(textOf(container)).not.toContain("workspace.read");
    expect(textOf(container)).not.toContain("read_selected_document");
    expect(bindings).toEqual([]);
  });

  test("a cached target never displays the previous project's authority while its selected package loads", async () => {
    // Populate the target capability cache, then leave it. Its ordinary
    // capabilities can render immediately on return; Panel declarations cannot.
    await render("project", "beta");
    await render("project", "alpha");
    await click(button("能力详情"));
    expect(textOf(container)).toContain("read_selected_document");
    const pending = deferred<PanelAppExtensionSummary[]>();
    readPanels = (cwd) =>
      cwd === "/tmp/capability-beta" ? pending.promise : Promise.resolve([panel(cwd)]);
    await render("project", "beta");
    expect(panelReads.at(-1)).toEqual(["/tmp/capability-beta", "zh"]);
    expect(textOf(container)).not.toContain("v1.4.0");
    expect(textOf(container)).not.toContain("workspace.read");
    expect(textOf(container)).not.toContain("read_selected_document");
    expect(textOf(container)).not.toContain("skills/alpha-reader/SKILL.md");

    await act(async () => {
      pending.resolve([panel("/tmp/capability-beta")]);
      await flushMicrotasks();
    });
    expect(textOf(container)).toContain("v2.1.0");
    await click(button("能力详情"));
    expect(textOf(container)).toContain("write_selected_document");
    expect(textOf(container)).toContain("process");
    expect(textOf(container)).not.toContain("workspace.read");
    expect(bindings).toEqual([]);
  });
});
