import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type {
  PanelAppExtensionSummary,
  PanelAppPreview,
  PanelAppUpdateCheck,
} from "../../preload/types";
import { ensureMiniDom, flushMicrotasks } from "../test-utils/renderHook";

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
  let apps: PanelAppExtensionSummary[];
  let changed: (() => void) | undefined;
  let checks: Array<[string, boolean | undefined]>;
  let previews: string[];
  let installs: unknown[];
  let check: (app: PanelAppExtensionSummary) => Promise<PanelAppUpdateCheck>;

  beforeEach(() => {
    savedBridge = Object.getOwnPropertyDescriptor(window, "codeshell");
    savedStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
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

  test("automatically displays the newer version and its source without opening a dialog", async () => {
    await render();
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
    expect(installs).toEqual([{ id: "video-studio", reviewToken: "reviewed-package-token" }]);
    expect(textOf(container)).not.toContain("有更新");
    expect(textOf(container)).not.toContain("个可更新");
    expect(textOf(container)).toContain("v0.6.3");
    expect(textOf(container)).toContain("已是来源中的最新版本");
    expect(button("从源码更新", container)).toBeDefined();
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
