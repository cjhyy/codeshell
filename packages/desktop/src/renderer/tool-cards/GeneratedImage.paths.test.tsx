import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { GenericToolCard } from "./GenericToolCard";
import { detectAttachments } from "./attachments";
import { ensureMiniDom, flushMicrotasks } from "../test-utils/renderHook";

const generated = (path: string, references = false) =>
  `Generated image with openai (owned-model)${references ? " from 2 reference image(s)" : ""}, saved to ${path}`;

const examples = [
  ["linux", "/owned/project with spaces/.code-shell/generated_images/1782-owned.png"],
  ["darwin", "/owned/个人 学习/图's [draft]!/.code-shell/generated_images/1782-owned.png"],
  ["win32", "C:\\owned\\project with spaces\\.code-shell\\generated_images\\1782-owned.png"],
  ["win32", "\\\\owned-server\\shared folder\\中文\\.code-shell\\generated_images\\1782-owned.png"],
] as const;

describe("complete paths from owned tool output formats", () => {
  test.each(examples)("GenerateImage preserves the complete %s path", (_platform, path) => {
    expect(detectAttachments("GenerateImage", "{}", generated(path))).toEqual([
      { path, kind: "image" },
    ]);
  });

  test("reference-image output preserves one complete path", () => {
    const path = "/owned/reference project/.code-shell/generated_images/1782-owned.png";
    expect(detectAttachments("GenerateImage", "{}", generated(path, true))).toEqual([
      { path, kind: "image" },
    ]);
  });

  test("an ambiguous formatter retains text without manufacturing a suffix attachment", () => {
    const path =
      "/owned/project, saved to another folder/.code-shell/generated_images/1782-owned.png";
    expect(detectAttachments("GenerateImage", "{}", generated(path))).toEqual([]);
  });

  test("successful Write metadata remains literal and does not gain a scraped suffix", () => {
    const path = "/owned/ folder /final report.md";
    expect(
      detectAttachments("Write", JSON.stringify({ file_path: path }), `wrote ${path}`),
    ).toEqual([{ path, kind: "markdown" }]);
  });

  test("a structured Write path retains its leading whitespace", () => {
    const path = " /owned/ report.md";
    expect(detectAttachments("Write", JSON.stringify({ file_path: path }), "File written")).toEqual(
      [{ path, kind: "markdown" }],
    );
  });

  test("Write directory spaces do not create a second residual card", () => {
    const path = "/owned/project with spaces/report.md";
    expect(
      detectAttachments("Write", JSON.stringify({ file_path: path }), `wrote ${path}`),
    ).toEqual([{ path, kind: "markdown" }]);
  });
});

function descendants(node: any): any[] {
  return [node, ...Array.from(node.childNodes ?? []).flatMap(descendants)];
}
function propsOf(node: any): Record<string, any> {
  const key = Object.keys(node).find((key) => key.startsWith("__reactProps$"));
  return key ? node[key] : {};
}

describe("actual generated-image tool card controls", () => {
  let root: Root;
  let container: HTMLElement;
  let oldBridge: typeof window.codeshell;
  let reads: string[];
  let opens: Array<{ path: string; cwd?: string }>;

  beforeEach(() => {
    ensureMiniDom();
    oldBridge = window.codeshell;
    reads = [];
    opens = [];
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
    window.codeshell = oldBridge;
  });

  test.each(examples)(
    "%s card previews and opens the exact original path once",
    async (platform, path) => {
      const cwd =
        platform === "win32" ? "C:\\owned\\project with spaces" : "/owned/project with spaces";
      window.codeshell = {
        platform,
        readImageDataUrl: async (value: string) => {
          reads.push(value);
          return "data:image/png;base64,owned";
        },
        openPath: async (value: string, root?: string) => {
          opens.push({ path: value, cwd: root });
        },
      } as unknown as typeof window.codeshell;
      await act(async () => {
        root.render(
          <GenericToolCard
            cwd={cwd}
            message={{
              kind: "tool",
              id: "owned-generated-image",
              toolName: "GenerateImage",
              args: "{}",
              result: generated(path),
              status: "succeeded",
              startedAt: 1,
            }}
          />,
        );
        await flushMicrotasks();
      });
      expect(reads).toEqual([]);
      const header = descendants(container).find(
        (node) => propsOf(node)["data-tool-heading"] === "",
      );
      expect(header).toBeDefined();
      await act(async () => {
        propsOf(header).onClick({ stopPropagation() {}, currentTarget: header });
        await flushMicrotasks();
      });
      expect(reads).toEqual([path]);
      const buttons = descendants(container).filter(
        (node) => node.tagName === "BUTTON" && propsOf(node).title === path,
      );
      expect(buttons).toHaveLength(1);
      await act(async () => {
        propsOf(buttons[0]).onClick();
        await flushMicrotasks();
      });
      expect(opens).toEqual([{ path, cwd }]);
    },
  );
});
