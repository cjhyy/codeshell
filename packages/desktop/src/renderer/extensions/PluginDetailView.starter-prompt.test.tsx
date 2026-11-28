import { afterEach, describe, expect, mock, test } from "bun:test";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ensureMiniDom, flushMicrotasks } from "../test-utils/renderHook";
import { DialogProvider } from "../ui/DialogProvider";
import { COMPOSER_SEED_REQUEST_EVENT } from "../chat/composerSeed";

// Keep this component test isolated from any PluginDetailView mocks installed
// by other renderer suites in the same Bun process.
// @ts-expect-error Bun supports query-suffixed TypeScript module imports.
const { PluginDetailView } = await import("./PluginDetailView.tsx?starter-prompt-component-test");

function reactPropsOf(node: unknown): Record<string, any> {
  const current = node as Record<string, any>;
  const key = Object.keys(current).find((name) => name.startsWith("__reactProps$"));
  return key ? current[key] : {};
}

function findElements(node: unknown, tagName: string): any[] {
  const current = node as { tagName?: string; childNodes?: unknown[] };
  return [
    ...(current.tagName === tagName ? [current] : []),
    ...(current.childNodes ?? []).flatMap((child) => findElements(child, tagName)),
  ];
}

function reactChildText(value: unknown): string {
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map(reactChildText).join("");
  if (value && typeof value === "object" && "props" in value) {
    return reactChildText((value as { props?: { children?: unknown } }).props?.children);
  }
  return "";
}

function buttonWithLabel(container: HTMLElement, label: string): any {
  return findElements(container, "BUTTON").find((button) =>
    reactChildText(reactPropsOf(button).children).includes(label),
  );
}

let root: Root | null = null;

afterEach(async () => {
  if (root) {
    await act(async () => {
      root?.unmount();
      await flushMicrotasks();
    });
  }
  root = null;
});

describe("PluginDetailView starter prompts", () => {
  test("puts a selected prompt in the composer bridge without submitting a run", async () => {
    ensureMiniDom();
    const run = mock(async () => ({ ok: true }));
    Object.defineProperty(window, "codeshell", {
      configurable: true,
      value: {
        getPluginDetail: async () => ({
          name: "video-editor",
          displayName: "Video Editor",
          installKey: "video-editor@local",
          marketplace: null,
          sourceLabel: "local",
          installPath: "/tmp/video-editor",
          installedAt: "2026-07-17T00:00:00.000Z",
          version: "1.0.0",
          skillCount: 0,
          defaultPrompt: ["Cut this interview into a concise highlight reel."],
          mediaAvailability: {
            composerIcon: false,
            logo: false,
            logoDark: false,
            screenshotCount: 0,
          },
          content: {
            skills: [],
            commands: [],
            agents: [],
            hooks: [],
            mcpServers: [],
            automationTemplates: [],
          },
        }),
        getPluginMedia: async () => null,
        run,
      },
    });

    const requests: unknown[] = [];
    const onRequest = (event: Event): void => {
      requests.push((event as CustomEvent<unknown>).detail);
    };
    window.addEventListener(COMPOSER_SEED_REQUEST_EVENT, onRequest);

    const container = document.createElement("div") as unknown as HTMLElement;
    root = createRoot(container);
    try {
      await act(async () => {
        root?.render(
          <DialogProvider>
            <PluginDetailView
              installKey="video-editor@local"
              cwd="/tmp/project"
              onBack={() => undefined}
            />
          </DialogProvider>,
        );
        await flushMicrotasks();
        await flushMicrotasks();
      });

      const usePrompt = buttonWithLabel(container, "放入对话框");
      expect(usePrompt).toBeDefined();
      await act(async () => {
        reactPropsOf(usePrompt).onClick();
        await flushMicrotasks();
      });

      expect(requests).toEqual([
        {
          text: "Cut this interview into a concise highlight reel.",
          source: "plugin-starter-prompt",
        },
      ]);
      expect(run).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener(COMPOSER_SEED_REQUEST_EVENT, onRequest);
    }
  });
});

describe("PluginDetailView native plugins", () => {
  // React writes a lone string child as textContent and anything else as text
  // nodes, and updates a text node through nodeValue (the mini DOM keeps data apart).
  function textOf(node: unknown): string {
    const current = node as {
      nodeType?: number;
      nodeValue?: string;
      data?: string;
      textContent?: string;
      childNodes?: unknown[];
    };
    if (current.nodeType === 3) return current.nodeValue ?? current.data ?? "";
    const children = (current.childNodes ?? []).map(textOf).join("");
    return children || (current.textContent ?? "");
  }

  function detail(native: Record<string, unknown>) {
    return {
      name: "tickets",
      displayName: "Tickets",
      installKey: "tickets@local",
      marketplace: null,
      sourceLabel: "local",
      installPath: "/tmp/tickets",
      installedAt: "2026-11-26T00:00:00.000Z",
      version: "1.0.0",
      skillCount: 0,
      mediaAvailability: { composerIcon: false, logo: false, logoDark: false, screenshotCount: 0 },
      content: {
        skills: [],
        commands: [],
        agents: [],
        hooks: [],
        mcpServers: [],
        automationTemplates: [],
      },
      native: {
        installKey: "tickets@local",
        plugin: "tickets",
        surface: {
          apiVersion: 1,
          hooks: ["pre_tool_use"],
          tools: ["lookup"],
          presets: [],
          promptSections: [],
          context: [],
          background: false,
          coreCapabilities: [],
          hostCapabilities: [],
        },
        baselineAvailable: false,
        diff: { added: {}, removed: {} },
        ...native,
      },
    };
  }

  async function render(api: Record<string, unknown>): Promise<HTMLElement> {
    ensureMiniDom();
    Object.defineProperty(window, "codeshell", {
      configurable: true,
      value: { getPluginMedia: async () => null, ...api },
    });
    const container = document.createElement("div") as unknown as HTMLElement;
    root = createRoot(container);
    await act(async () => {
      root?.render(
        <DialogProvider>
          <PluginDetailView
            installKey="tickets@local"
            cwd="/tmp/project"
            onBack={() => undefined}
          />
        </DialogProvider>,
      );
      await flushMicrotasks();
      await flushMicrotasks();
      await flushMicrotasks();
    });
    return container;
  }

  test("a plugin waiting for approval shows what it declares and one approval, and runs nothing", async () => {
    const nativePluginRuntime = mock(async () => ({ kind: "loaded", plugins: [] }));
    const container = await render({
      getPluginDetail: async () => detail({ state: "pending" }),
      nativePluginRuntime,
    });
    const text = textOf(container);
    expect(text).toContain("原生插件等待授权");
    expect(text).toContain("pre_tool_use");
    expect(text).toContain("lookup");
    expect(buttonWithLabel(container, "授权此插件")).toBeDefined();
    expect(buttonWithLabel(container, "撤销授权")).toBeUndefined();
    // Nothing is asked of the agent for a plugin that cannot run.
    expect(nativePluginRuntime).not.toHaveBeenCalled();
  });

  test("an approved plugin shows its process and can be restarted", async () => {
    const running = {
      installKey: "tickets@local",
      plugin: "tickets",
      moduleId: "plugin-tickets-0123abcd",
      state: "running",
      pid: 4242,
      restarts: 0,
      calls: 3,
      failures: 1,
      timeouts: 0,
      lastError: "TIMEOUT: the plugin did not answer in time",
      logFile: "/logs/plugin-tickets-0123abcd.log",
    };
    const nativePluginRuntime = mock(async () => ({ kind: "loaded", plugins: [running] }));
    const container = await render({
      getPluginDetail: async () => detail({ state: "approved" }),
      nativePluginRuntime,
    });
    const text = textOf(container);
    expect(text).toContain("原生插件已授权");
    expect(text).toContain("进程 4242");
    expect(text).toContain("最近错误：TIMEOUT: the plugin did not answer in time");
    expect(nativePluginRuntime).toHaveBeenCalledWith("status");

    const restart = buttonWithLabel(container, "重启插件");
    expect(restart).toBeDefined();
    await act(async () => {
      reactPropsOf(restart).onClick();
      await flushMicrotasks();
    });
    expect(nativePluginRuntime).toHaveBeenCalledWith("restart", "tickets@local");
  });

  test("an open log is read again after a restart and after a refresh", async () => {
    const running = {
      installKey: "tickets@local",
      plugin: "tickets",
      moduleId: "plugin-tickets-0123abcd",
      state: "running",
      pid: 4242,
      restarts: 0,
      calls: 0,
      failures: 0,
      timeouts: 0,
      logFile: "/logs/plugin-tickets-0123abcd.log",
    };
    const nativePluginRuntime = mock(async () => ({ kind: "loaded", plugins: [running] }));
    const logs = ["started pid 4242", "started pid 4243 after the restart", "after the refresh"];
    let reads = 0;
    const nativePluginLog = mock(async () => logs[Math.min(reads++, logs.length - 1)]);
    const container = await render({
      getPluginDetail: async () => detail({ state: "approved" }),
      nativePluginRuntime,
      nativePluginLog,
    });
    const click = async (label: string) => {
      const button = buttonWithLabel(container, label);
      expect(button).toBeDefined();
      await act(async () => {
        reactPropsOf(button).onClick();
        await flushMicrotasks();
        await flushMicrotasks();
      });
    };

    // A closed log is not read just because the plugin restarted.
    await click("重启插件");
    expect(nativePluginLog).not.toHaveBeenCalled();
    await click("查看日志");
    expect(textOf(container)).toContain("started pid 4242");
    await click("重启插件");
    expect(textOf(container)).toContain("started pid 4243 after the restart");
    await click("刷新");
    expect(textOf(container)).toContain("after the refresh");
    expect(nativePluginLog).toHaveBeenCalledTimes(3);
  });
});
