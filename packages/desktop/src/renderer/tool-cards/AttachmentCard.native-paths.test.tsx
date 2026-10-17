import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { AttachmentCard } from "./AttachmentCard";
import { InlineMedia } from "../chat/InlineMedia";
import { ensureMiniDom, flushMicrotasks } from "../test-utils/renderHook";

function renderedText(node: any): string {
  return (
    ((node.nodeType === 3 ? node.nodeValue : node.textContent) ?? "") +
    Array.from(node.childNodes ?? [])
      .map(renderedText)
      .join("")
  );
}

describe("native attachment paths", () => {
  let root: Root;
  let container: HTMLElement;
  let originalBridge: typeof window.codeshell;
  let reads: Array<{ path: string; cwd?: string }>;

  beforeEach(() => {
    ensureMiniDom();
    originalBridge = window.codeshell;
    reads = [];
    window.codeshell = {
      platform: "win32",
      readImageDataUrl: async (path: string, options?: { cwd?: string }) => {
        reads.push({ path, cwd: options?.cwd });
        return "data:image/png;base64,owned";
      },
      getMediaPreview: async () => null,
      releaseMediaPreview: async () => undefined,
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

  async function render(element: React.ReactNode) {
    await act(async () => {
      root.render(element);
      await flushMicrotasks();
    });
  }

  test.each([
    ["C:\\owned\\图.png", String.raw`C:\workspace`],
    ["C:\\owned\\图.png", undefined],
    ["\\\\server\\share\\图.png", String.raw`C:\workspace`],
  ] as const)(
    "Windows absolute image %s retains its exact IPC path (cwd %s)",
    async (path, cwd) => {
      await render(<AttachmentCard attachment={{ path, kind: "image" }} cwd={cwd} />);
      expect(reads).toEqual([{ path, cwd }]);
      expect(renderedText(container)).toContain("图.png");
      expect(renderedText(container)).not.toContain(path);
    },
  );

  test("Windows relative image joins its native cwd once", async () => {
    await render(
      <AttachmentCard
        attachment={{ path: "images\\图.png", kind: "image" }}
        cwd={String.raw`C:\workspace`}
      />,
    );
    expect(reads).toEqual([
      { path: "C:\\workspace\\images\\图.png", cwd: String.raw`C:\workspace` },
    ]);
  });

  test.each(["linux", "darwin"] as const)(
    "%s retains a literal backslash in the file label",
    async (platform) => {
      window.codeshell = { ...window.codeshell, platform };
      await render(
        <AttachmentCard attachment={{ path: String.raw`/owned/a\b.png`, kind: "image" }} />,
      );
      expect(reads).toEqual([{ path: String.raw`/owned/a\b.png`, cwd: undefined }]);
      expect(renderedText(container)).toContain(String.raw`a\b.png`);
    },
  );

  test("an unavailable POSIX media preview keeps its literal filename", async () => {
    window.codeshell = { ...window.codeshell, platform: "linux" };
    await render(<InlineMedia path={String.raw`/owned/a\b.wav`} kind="audio" sessionId="owned" />);
    expect(renderedText(container)).toContain(String.raw`a\b.wav`);
  });
});
