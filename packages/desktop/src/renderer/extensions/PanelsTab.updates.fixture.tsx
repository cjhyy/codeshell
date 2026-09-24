import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type {
  PanelAppExtensionSummary,
  PanelAppPreview,
  PanelAppUpdateCheck,
} from "../../preload/types";
import { loadProjects, saveProjects, type TrackedProject } from "../projects";
import { ensureMiniDom, flushMicrotasks } from "../test-utils/renderHook";

// Imported only by the isolated test worker, before Radix observes the DOM.
ensureMiniDom();
const { PanelsTab } = await import("./PanelsTab");
const { DialogProvider } = await import("../ui/DialogProvider");
const { ToastProvider } = await import("../ui/ToastProvider");

function props(node: any): Record<string, any> {
  const key = Object.keys(node).find((name) => name.startsWith("__reactProps$"));
  return key ? node[key] : {};
}

function nodes(node: any): any[] {
  return [node, ...Array.from(node.childNodes ?? []).flatMap(nodes)];
}

function textOf(node: any): string {
  if (node.nodeType === 3) return node.nodeValue ?? node.data ?? "";
  const children = Array.from(node.childNodes ?? []);
  return children.length ? children.map(textOf).join("") : (node.textContent ?? "");
}

function button(label: string, scope: any = document.body): any {
  const found = nodes(scope).find((node) => node.tagName === "BUTTON" && textOf(node) === label);
  expect(found).toBeDefined();
  return found;
}

function panel(id = "video-studio", kind: "git" | "dir" | "zip" = "git"): PanelAppExtensionSummary {
  return {
    id: `panel-app:${id}`,
    appId: id,
    title: id === "video-studio" ? "视频工作台" : id,
    version: "0.6.2",
    revision: "revision-1",
    bindingRevision: "a".repeat(64),
    hostId: id,
    kind: "panel-app",
    icon: "panel",
    singleton: true,
    permissions: ["storage"],
    enabled: false,
    projectBound: false,
    updateSource: {
      kind,
      label: kind === "git" ? "owner/panels/video-studio" : "/panels/local",
      available: true,
    },
  };
}

const preview: PanelAppPreview = {
  id: "video-studio",
  version: "0.6.3",
  title: { default: "视频工作台" },
  entry: "app/index.html",
  icon: "panel",
  singleton: true,
  permissions: ["storage"],
  alreadyInstalled: true,
  reviewToken: "reviewed-package-token",
  source: { kind: "git", label: "owner/panels/video-studio" },
  warnings: [],
};

describe("Panel App update controls", () => {
  let root: Root;
  let container: HTMLElement;
  let savedBridge: PropertyDescriptor | undefined;
  let savedStorage: PropertyDescriptor | undefined;
  let savedProjects: TrackedProject[];
  let bindingReads: string[];
  let apps: PanelAppExtensionSummary[];
  let changed: (() => void) | undefined;
  let checks: Array<[string, boolean | undefined]>;
  let previews: string[];
  let installs: unknown[];
  let check: (app: PanelAppExtensionSummary) => Promise<PanelAppUpdateCheck>;

  beforeEach(() => {
    savedBridge = Object.getOwnPropertyDescriptor(window, "codeshell");
    savedStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    // V2 projects live in a module snapshot, independently of localStorage.
    savedProjects = loadProjects();
    saveProjects([
      {
        id: "panel-updates-project",
        name: "Panel updates",
        path: "/tmp/project",
        roots: [
          { id: "panel-updates-root", path: "/tmp/project", name: "Panel updates", addedAt: 1 },
        ],
        primaryRootId: "panel-updates-root",
        addedAt: 1,
      },
    ]);
    bindingReads = [];
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: { getItem: () => null, setItem: () => undefined },
    });
    apps = [panel()];
    checks = [];
    previews = [];
    installs = [];
    changed = undefined;
    check = async (app) => ({
      id: app.appId,
      currentVersion: app.version,
      latestVersion: "0.6.3",
      status: app.version === "0.6.3" ? "up-to-date" : "update-available",
      checkedAt: "2026-09-16T10:00:00.000Z",
      sourceKind: app.updateSource.kind,
    });
    Object.defineProperty(window, "codeshell", {
      configurable: true,
      value: {
        listPanelAppExtensions: async () => [...apps],
        getSettings: async () => ({}),
        getPanelAppBindings: async (cwd: string) => {
          bindingReads.push(cwd);
          return apps.map((app) => ({
            appId: app.appId,
            revision: "a".repeat(64),
            bound: app.projectBound,
            globalDisabled: false,
            version: app.version,
          }));
        },
        onPanelAppsChanged: (callback: () => void) => {
          changed = callback;
          return () => {
            changed = undefined;
          };
        },
        checkPanelAppUpdate: (id: string, force?: boolean) => {
          checks.push([id, force]);
          return check(apps.find((app) => app.appId === id)!);
        },
        previewPanelAppUpdate: async (id: string) => {
          previews.push(id);
          return { ok: true, preview };
        },
        installPanelAppUpdate: async (input: unknown) => {
          installs.push(input);
          apps = apps.map((app) => ({ ...app, version: "0.6.3", revision: "revision-2" }));
          changed?.();
          return { ok: true, id: "video-studio" };
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

  async function render() {
    await act(async () => {
      root.render(
        <ToastProvider>
          <DialogProvider>
            <PanelsTab cwd="/tmp/project" activeProjectPath="/tmp/project" query="" />
          </DialogProvider>
        </ToastProvider>,
      );
      await flushMicrotasks();
    });
  }

  async function click(label: string) {
    await act(async () => {
      props(button(label)).onClick();
      await flushMicrotasks();
    });
  }

  test("project toggles send the displayed Host revision and surface a concurrent phone change", async () => {
    const writes: unknown[] = [];
    Object.assign(window.codeshell, {
      setPanelAppProjectBinding: async (...input: unknown[]) => {
        writes.push(input);
        throw new Error("面板配置已改变，请刷新后重试。");
      },
      setConfigurationSettings: () => {
        throw new Error("Generic settings must not write Panel bindings");
      },
    });
    await render();
    await click("展开");
    const toggle = nodes(container).find((node) => props(node).role === "switch");
    expect(toggle).toBeDefined();
    await act(async () => {
      props(toggle).onClick({
        stopPropagation() {},
        isPropagationStopped: () => false,
        defaultPrevented: false,
      });
      await flushMicrotasks();
    });
    expect(writes).toEqual([["/tmp/project", "video-studio", true, "a".repeat(64)]]);
    expect(textOf(container)).toContain("面板配置已改变，请刷新后重试。");
    expect(
      props(nodes(container).find((node) => props(node).role === "switch"))["aria-checked"],
    ).toBe(false);
  });

  test("a rejected project installation never reports success or attempts a separate binding", async () => {
    const writes: unknown[] = [];
    Object.assign(window.codeshell, {
      pickPanelAppSource: async () => ({ kind: "dir", path: "/source" }),
      previewLocalPanelApp: async (_source: unknown, cwd: string) => {
        expect(cwd).toBe("/tmp/project");
        return {
          ok: true,
          preview: {
            ...preview,
            alreadyInstalled: false,
            source: { kind: "dir", label: "source" },
          },
        };
      },
      installLocalPanelApp: async (input: unknown) => {
        writes.push(input);
        return { ok: false, error: "项目面板配置已改变，请重新预览。" };
      },
      setPanelAppProjectBinding: async () => {
        throw new Error("Installation must bind inside the reviewed Host operation");
      },
    });
    await render();
    await click("选择源码文件夹");
    expect(textOf(document.body)).toContain("目标项目：Panel updates");
    await click("确认并安装");
    expect(textOf(document.body)).not.toContain("已安装并绑定到");
    expect(textOf(container)).toContain("项目面板配置已改变，请重新预览。");
    expect(writes).toEqual([
      {
        cwd: "/tmp/project",
        source: { kind: "dir", path: "/source" },
        reviewToken: preview.reviewToken,
        overwrite: false,
      },
    ]);
  });

  test("automatically displays the newer version and its source without opening a dialog", async () => {
    await render();
    expect(bindingReads).toEqual(["/tmp/project"]);
    expect(textOf(container)).toContain("有更新");
    expect(textOf(container)).toContain("v0.6.2 → v0.6.3");
    expect(textOf(container)).toContain("1 个可更新");
    expect(textOf(container)).toContain("GitHub / Git");
    expect(textOf(document.body)).not.toContain("审查 Panel App 更新");
    expect(previews).toEqual([]);
    expect(installs).toEqual([]);
  });

  test("checking again retries an error instead of claiming the panel is current", async () => {
    check = async () => {
      throw new Error("Cannot reach GitHub");
    };
    await render();
    expect(textOf(container)).toContain("检查失败，暂时无法确认是否有更新");
    expect(textOf(container)).not.toContain("已是来源中的最新版本");
    expect(textOf(container)).not.toContain("个可更新");
    await click("检查更新");
    expect(checks).toEqual([
      ["video-studio", false],
      ["video-studio", true],
    ]);
    expect(installs).toEqual([]);
  });

  test("the update action opens the complete review and installs only after confirmation", async () => {
    await render();
    await click("更新到 v0.6.3");
    expect(previews).toEqual(["video-studio"]);
    expect(installs).toEqual([]);
    expect(textOf(document.body)).toContain("审查 Panel App 更新");
    expect(textOf(document.body)).toContain("v0.6.2 → v0.6.3");
    expect(textOf(document.body)).toContain("Host 权限");
    await click("确认并更新");
    expect(installs).toEqual([
      { cwd: "/tmp/project", id: "video-studio", reviewToken: "reviewed-package-token" },
    ]);
    expect(textOf(container)).not.toContain("有更新");
    expect(textOf(container)).not.toContain("个可更新");
    expect(textOf(container)).toContain("v0.6.3");
    expect(textOf(container)).toContain("已是来源中的最新版本");
    expect(button("从源码更新", container)).toBeDefined();
  });

  test("a bound project's retained version is reviewed before the native restore token is submitted", async () => {
    apps = [{ ...panel(), projectBound: true }];
    const calls: unknown[] = [];
    const history = {
      appId: "video-studio",
      title: { default: "Video Studio" },
      expectedRevision: "a".repeat(64),
      current: { version: "0.6.2", packageDigest: "b".repeat(64) },
      unavailablePackages: 0,
      versions: [
        {
          version: "0.6.1",
          packageDigest: "c".repeat(64),
          permissions: ["workspace.write"],
          compatibility: { supported: true, reasons: [] },
        },
      ],
    };
    Object.assign(window.codeshell, {
      getPanelAppPackageHistory: async (...args: unknown[]) => {
        calls.push(["history", ...args]);
        return history;
      },
      previewPanelAppRestore: async (...args: unknown[]) => {
        calls.push(["preview", ...args]);
        return {
          ...history.versions[0],
          appId: history.appId,
          title: history.title,
          current: history.current,
          expectedRevision: history.expectedRevision,
          addedPermissions: ["workspace.write"],
          reviewToken: "native-restore-review",
          expiresAt: Date.now() + 60_000,
        };
      },
      restorePanelAppPackage: async (...args: unknown[]) => {
        calls.push(["restore", ...args]);
        return { id: history.appId, packageDigest: "c".repeat(64) };
      },
    });
    await render();
    await click("展开");
    await click("项目版本");
    expect(textOf(document.body)).toContain("不会恢复旧数据");
    await click("审阅 v0.6.1");
    expect(textOf(document.body)).toContain("新增权限");
    expect(calls).toHaveLength(2);
    await click("确认权限并恢复项目版本");
    expect(calls).toEqual([
      ["history", "/tmp/project", "video-studio", "a".repeat(64)],
      ["preview", "/tmp/project", "video-studio", "c".repeat(64), "a".repeat(64)],
      ["restore", "/tmp/project", "native-restore-review"],
    ]);
  });

  test("an unavailable project package is repaired from a separate diagnostic row", async () => {
    apps = [];
    const calls: unknown[] = [];
    const history = {
      appId: "video-studio",
      title: { default: "Video Studio" },
      expectedRevision: "a".repeat(64),
      current: { version: "0.6.2", packageDigest: "b".repeat(64), unavailable: true },
      unavailablePackages: 0,
      versions: [
        {
          version: "0.6.1",
          packageDigest: "c".repeat(64),
          permissions: ["workspace.write"],
          compatibility: { supported: true, reasons: [] },
        },
      ],
    };
    Object.assign(window.codeshell, {
      getPanelAppBindings: async () => [
        {
          appId: "video-studio",
          revision: "a".repeat(64),
          bound: true,
          globalDisabled: false,
          version: "0.6.2",
          unavailable: true,
        },
      ],
      getPanelAppPackageHistory: async (...args: unknown[]) => {
        calls.push(["history", ...args]);
        return history;
      },
      previewPanelAppRestore: async (...args: unknown[]) => {
        calls.push(["preview", ...args]);
        return {
          ...history.versions[0],
          appId: history.appId,
          title: history.title,
          current: history.current,
          expectedRevision: history.expectedRevision,
          addedPermissions: ["workspace.write"],
          reviewToken: "native-restore-review",
          expiresAt: Date.now() + 60_000,
        };
      },
      restorePanelAppPackage: async (...args: unknown[]) => {
        calls.push(["restore", ...args]);
        return { id: history.appId, packageDigest: "c".repeat(64) };
      },
    });
    await render();
    await click("检查可用版本");
    expect(textOf(document.body)).toContain("全部权限");
    expect(textOf(document.body)).toContain("不会恢复旧数据");
    await click("审阅 v0.6.1");
    expect(textOf(document.body)).toContain("需重新确认");
    expect(calls).toHaveLength(2);
    await click("确认权限并恢复项目版本");
    expect(calls).toEqual([
      ["history", "/tmp/project", "video-studio", "a".repeat(64)],
      ["preview", "/tmp/project", "video-studio", "c".repeat(64), "a".repeat(64)],
      ["restore", "/tmp/project", "native-restore-review"],
    ]);
  });

  test("catalog changes from another window remove an obsolete update notice", async () => {
    await render();
    expect(textOf(container)).toContain("有更新");
    await act(async () => {
      apps = [{ ...panel(), version: "0.6.3", revision: "replacement-revision" }];
      changed!();
      await flushMicrotasks();
    });
    expect(textOf(container)).not.toContain("有更新");
    expect(textOf(container)).toContain("已是来源中的最新版本");
  });

  test("local folders, archives, older sources, and same versions remain distinguishable", async () => {
    apps = [panel("same"), panel("older"), panel("local", "dir"), panel("archive", "zip")];
    check = async (app) => ({
      id: app.appId,
      currentVersion: app.version,
      latestVersion: app.appId === "older" ? "0.6.1" : "0.6.2",
      status:
        app.appId === "archive"
          ? "unsupported"
          : app.appId === "older"
            ? "source-older"
            : "up-to-date",
      checkedAt: "2026-09-16T10:00:00.000Z",
      sourceKind: app.updateSource.kind,
    });
    await render();
    const text = textOf(container);
    expect(text).toContain("已是来源中的最新版本");
    expect(text).toContain("来源版本 v0.6.1 低于已安装版本");
    expect(text).toContain("本地目录");
    expect(text).toContain("压缩包");
    expect(text).toContain("此本地来源不支持自动检查版本，请导入新版安装包");
    expect(text).not.toContain("个可更新");
  });
});
