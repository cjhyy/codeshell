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
            panels: [],
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
