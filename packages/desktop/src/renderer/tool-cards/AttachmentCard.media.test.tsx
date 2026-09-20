import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ToolCard } from "./index";
import { ToolGroupCard } from "../messages/ToolGroupCard";
import { TurnProcessGroupCard } from "../messages/TurnProcessGroupCard";
import { buildStreamItems, type RenderedTurnProcessGroup } from "../messages/streamGroups";
import { ensureMiniDom, flushMicrotasks } from "../test-utils/renderHook";
import type { ToolMessage } from "../types";

function descendants(node: any): any[] {
  return [node, ...Array.from(node.childNodes ?? []).flatMap(descendants)];
}

function propsOf(node: any): Record<string, any> {
  const key = Object.keys(node).find((name) => name.startsWith("__reactProps$"));
  return key ? node[key] : {};
}

describe("tool media attachment authority and disclosure", () => {
  let root: Root;
  let container: HTMLElement;
  let originalBridge: typeof window.codeshell;
  const requests = mock(async (_request: unknown) => ({
    url: "csmedia://preview/test-token",
    kind: "audio" as const,
    mimeType: "audio/wav",
    name: "voice.wav",
  }));
  const release = mock(async (_url: string) => undefined);

  beforeEach(() => {
    ensureMiniDom();
    originalBridge = window.codeshell;
    requests.mockClear();
    release.mockClear();
    window.codeshell = {
      getMediaPreview: requests,
      releaseMediaPreview: release,
    } as unknown as typeof window.codeshell;
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
    window.codeshell = originalBridge;
  });

  function message(write = false): ToolMessage {
    return {
      kind: "tool",
      id: "media-tool",
      toolName: write ? "Write" : "mcpExportAudio",
      args: JSON.stringify({ file_path: "output/voice.wav" }),
      result: "Saved output/voice.wav",
      status: "succeeded",
      startedAt: 1,
      endedAt: 2,
    };
  }

  const authority = {
    cwd: "/task-workspace",
    sessionId: "owning-task",
    sessionMainRootId: "root-current",
    rootStatus: "ok" as const,
  };

  async function render(element: React.ReactNode) {
    await act(async () => {
      root.render(element);
      await flushMicrotasks();
    });
  }

  async function toggle(node: any) {
    await act(async () => {
      propsOf(node).onClick({ stopPropagation() {} });
      await flushMicrotasks();
    });
  }

  test.each(["file", "generic-group", "turn-group"] as const)(
    "%s loads only expanded media using its owning task and releases on collapse",
    async (kind) => {
      const tool = message(kind === "file");
      if (kind === "file") {
        await render(<ToolCard message={tool} {...authority} />);
      } else if (kind === "generic-group") {
        await render(
          <ToolGroupCard
            group={{ kind: "tool_group", id: "media-group", items: [tool] }}
            {...authority}
          />,
        );
      } else {
        const group = buildStreamItems([
          { kind: "user", id: "u", text: "Export audio" },
          tool,
          { kind: "assistant", id: "a", text: "Done", done: true },
        ]).find((item) => item.kind === "turn_process_group") as RenderedTurnProcessGroup;
        await render(<TurnProcessGroupCard group={group} {...authority} />);
      }

      expect(requests).not.toHaveBeenCalled();
      const outerToggle = descendants(container).find(
        (node) => node.tagName === "BUTTON" && propsOf(node)["aria-expanded"] === false,
      );
      await toggle(outerToggle);
      if (kind !== "file") {
        expect(requests).not.toHaveBeenCalled();
        const toolToggle = descendants(container).find(
          (node) => node.tagName === "BUTTON" && propsOf(node)["aria-expanded"] === false,
        );
        await toggle(toolToggle);
      }
      expect(requests).toHaveBeenCalledWith({
        sessionId: authority.sessionId,
        path: "output/voice.wav",
        rootId: authority.sessionMainRootId,
      });
      const audio = descendants(container).find((node) => node.tagName === "AUDIO");
      expect(propsOf(audio).preload).toBe("none");
      expect(propsOf(audio).src).toBe("csmedia://preview/test-token");
      await toggle(outerToggle);
      expect(release).toHaveBeenCalledWith("csmedia://preview/test-token");
    },
  );

  test("a child tool without its own task authority cannot request a preview", async () => {
    await render(<ToolCard message={message()} />);
    const toggleButton = descendants(container).find(
      (node) => node.tagName === "BUTTON" && propsOf(node)["aria-expanded"] === false,
    );
    await toggle(toggleButton);
    expect(requests).not.toHaveBeenCalled();
    expect(descendants(container).some((node) => node.tagName === "AUDIO")).toBe(false);
  });
});
