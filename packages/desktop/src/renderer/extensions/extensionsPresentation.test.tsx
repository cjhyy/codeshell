import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { fileURLToPath } from "node:url";
import { ensureMiniDom, flushMicrotasks } from "../test-utils/renderHook";
import type { SkillSummary } from "../../main/skills-service";

// Initialize the DOM before loading the UI for standalone component runs.
ensureMiniDom();
const { DiscoverHome } = await import("./DiscoverHome");
const { ManagePage } = await import("./ManagePage");
const { SkillsTab } = await import("./SkillsTab");
const { DialogProvider } = await import("../ui/DialogProvider");
const { PAGE_REGISTRY } = await import("../pages/PageRegistry");
const { SettingsPage } = await import("../settings/SettingsPage");

function props(node: any): Record<string, any> {
  const key = Object.keys(node).find((name) => name.startsWith("__reactProps$"));
  return key ? node[key] : {};
}

function nodes(node: any): any[] {
  return [node, ...Array.from(node.childNodes ?? []).flatMap(nodes)];
}

function textOf(node: any): string {
  if (node.nodeType === 3) return node.data ?? node.textContent ?? "";
  const children = Array.from(node.childNodes ?? []);
  return children.length ? children.map(textOf).join("") : (node.textContent ?? "");
}

const target = { noRepo: true } as const;
const skill: SkillSummary = {
  name: "review-skill",
  description: "Review a document carefully",
  filePath: "/tmp/review/SKILL.md",
  source: "user",
  enabled: true,
};
const plugin = {
  name: "sample-plugin",
  displayName: "Sample Plugin",
  installKey: "sample-plugin@local",
  sourceLabel: "local",
  marketplace: null,
  skillCount: 1,
  mediaAvailability: { logo: false, logoDark: false, composerIcon: false, screenshotCount: 0 },
};
let root: Root;
let container: HTMLElement;
let apiBefore: PropertyDescriptor | undefined;
let storageBefore: PropertyDescriptor | undefined;
let readCalls: string[];

beforeEach(() => {
  ensureMiniDom();
  readCalls = [];
  apiBefore = Object.getOwnPropertyDescriptor(window, "codeshell");
  storageBefore = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: { getItem: () => null, setItem: () => undefined },
  });
  Object.defineProperty(window, "codeshell", {
    configurable: true,
    value: {
      noRepoCwd: async () => "/tmp",
      listPlugins: async () => [plugin],
      checkPluginUpdate: async () => ({ updateAvailable: false }),
      listPanelAppExtensions: async () => [],
      listSkills: async () => [skill],
      checkSkillUpdate: async () => ({ updateAvailable: false }),
      getSettings: async () => ({}),
      listMergedMcpServers: async () => ({}),
      readSkillBody: async (_target: unknown, path: string) => {
        readCalls.push(path);
        return "Skill instructions are readable.";
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
  if (apiBefore) Object.defineProperty(window, "codeshell", apiBefore);
  else Reflect.deleteProperty(window, "codeshell");
  if (storageBefore) Object.defineProperty(globalThis, "localStorage", storageBefore);
  else Reflect.deleteProperty(globalThis, "localStorage");
});

async function render(child: React.ReactNode) {
  await act(async () => {
    root.render(<DialogProvider>{child}</DialogProvider>);
    await flushMicrotasks();
  });
}

async function click(node: any) {
  await act(async () => {
    props(node).onClick({
      stopPropagation() {},
      isPropagationStopped: () => false,
      defaultPrevented: false,
    });
    await flushMicrotasks();
  });
}

describe("extension discovery search", () => {
  test("submits the typed query to the chosen category with a native submit button", async () => {
    const opened: unknown[] = [];
    await render(
      <DiscoverHome
        cwd="/tmp"
        configurationTarget={target}
        onOpenManage={(...args) => opened.push(args)}
      />,
    );
    const search = nodes(container).find(
      (node) => node.tagName === "INPUT" && props(node).type === "search",
    );
    const selector = nodes(container).find((node) => node.tagName === "SELECT");
    expect(selector).toBeDefined();
    await act(async () => {
      props(selector).onChange({ target: { value: "plugins" } });
      props(search).onChange({ target: { value: "  sample  " } });
      await flushMicrotasks();
    });
    expect(props(search)["aria-label"]).toContain("插件包");
    const submit = nodes(container).find(
      (node) => node.tagName === "BUTTON" && props(node).type === "submit",
    );
    expect(textOf(submit)).toContain("搜索");
    props(nodes(container).find((node) => node.tagName === "FORM")).onSubmit({
      preventDefault() {},
    });
    expect(opened).toEqual([["plugins", "sample"]]);
  });

  test("all overview cards remain native buttons for navigation", async () => {
    const opened: unknown[] = [];
    await render(
      <DiscoverHome
        cwd="/tmp"
        configurationTarget={target}
        onOpenManage={(...args) => opened.push(args)}
      />,
    );
    const market = nodes(container).find(
      (node) => node.tagName === "BUTTON" && textOf(node).includes("添加远程插件市场"),
    );
    expect(props(market).type).toBe("button");
    await click(market);
    expect(opened).toEqual([["market"]]);
  });
});

describe("extension management", () => {
  test("the actual sidebar route opens the manager with a standalone page heading", async () => {
    await render(
      <React.Suspense fallback={null}>
        {PAGE_REGISTRY.get("extensions")!.render!({
          activeProjectPath: null,
          runsInitialRunId: null,
        })}
      </React.Suspense>,
    );
    expect(
      nodes(container)
        .filter((node) => node.tagName === "H1")
        .map(textOf),
    ).toEqual(["插件包"]);
    expect(textOf(container)).toContain("Sample Plugin");
    expect(nodes(container).some((node) => node.tagName === "FORM")).toBe(false);
    expect(
      nodes(container).some((node) =>
        String(props(node).className ?? "").includes("h-full min-w-0 overflow-y-auto"),
      ),
    ).toBe(true);
  });

  test("the settings route supplies its own heading without nesting the standalone page shell", async () => {
    await render(
      <SettingsPage
        initialModule="plugins-skills"
        activeProjectPath={null}
        projects={[]}
        sessionIndices={{}}
        onRestoreArchivedSession={() => undefined}
        onDeleteArchivedSession={() => undefined}
        isMac={false}
        isFullscreen={false}
        onBack={() => undefined}
      />,
    );
    const headings = nodes(container).filter((node) => node.tagName === "H1");
    expect(headings).toHaveLength(1);
    expect(textOf(headings[0])).toBe("扩展");
    expect(textOf(container)).toContain("Sample Plugin");
    expect(
      nodes(container).some((node) =>
        String(props(node).className ?? "").includes("h-full min-w-0 overflow-y-auto"),
      ),
    ).toBe(false);
  });

  test("distinguishes a filtered plugin list from no installation and clears its search", async () => {
    await render(
      <ManagePage
        cwd="/tmp"
        configurationTarget={target}
        activeProjectPath={null}
        initialQuery="missing"
      />,
    );
    expect(textOf(container)).toContain("没有匹配的插件");
    expect(textOf(container)).not.toContain("还没有安装插件");
    const search = nodes(container).find(
      (node) => node.tagName === "INPUT" && props(node).type === "search",
    );
    await click(
      nodes(container).find(
        (node) => node.tagName === "BUTTON" && props(node)["aria-label"] === "清除搜索",
      ),
    );
    expect(props(search).value).toBe("");
    expect(document.activeElement).toBe(search);
    expect(textOf(container)).toContain("Sample Plugin");
    const toggle = nodes(container).find((node) => props(node).role === "switch");
    expect(props(toggle)["aria-label"]).toContain("Sample Plugin");
  });

  test("switching management categories preserves the entered filter", async () => {
    await render(
      <ManagePage
        cwd="/tmp"
        configurationTarget={target}
        activeProjectPath={null}
        initialQuery="review"
      />,
    );
    const skillsButton = nodes(container).find(
      (node) => node.tagName === "BUTTON" && textOf(node) === "技能",
    );
    await click(skillsButton);
    const search = nodes(container).find(
      (node) => node.tagName === "INPUT" && props(node).type === "search",
    );
    expect(props(search).value).toBe("review");
    expect(props(search)["aria-label"]).toBe("搜索技能");
    expect(textOf(container)).toContain("review-skill");
  });

  test("skill details open through a native button and the switch stays independently named", async () => {
    const toggles: unknown[] = [];
    await render(
      <SkillsTab
        configurationTarget={target}
        query=""
        isEnabled={() => true}
        onToggle={(...args) => toggles.push(args)}
      />,
    );
    const open = nodes(container).find(
      (node) => props(node)["aria-label"] === "查看技能 review-skill",
    );
    expect(open.tagName).toBe("BUTTON");
    expect(props(open).type).toBe("button");
    const toggle = nodes(container).find((node) => props(node).role === "switch");
    expect(props(toggle)["aria-label"]).toBe("启用或停用技能 review-skill");
    await click(toggle);
    expect(toggles).toEqual([[skill, false]]);
    open.focus();
    await click(open);
    expect(readCalls).toEqual([skill.filePath]);
    expect(toggles).toEqual([[skill, false]]);
  });

  test("the real skill dialog closes and returns keyboard focus", () => {
    // Other renderer suites mock the shared Dialog module globally. A fresh
    // process verifies the real portal/focus behavior without inheriting them.
    const result = Bun.spawnSync({
      cmd: [
        process.execPath,
        fileURLToPath(new URL("./SkillDetailModal.fixture.tsx", import.meta.url)),
      ],
      stdout: "pipe",
      stderr: "pipe",
    });
    expect({ exitCode: result.exitCode, stderr: result.stderr.toString() }).toEqual({
      exitCode: 0,
      stderr: "",
    });
  });
});
