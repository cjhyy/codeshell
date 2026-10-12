import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Markdown } from "./Markdown";
import { LocalRuntimeActionsContext } from "./runtime/RuntimeCapabilities";
import { AttachmentCard } from "./tool-cards/AttachmentCard";
import { FileToolCard } from "./tool-cards/FileToolCard";
import { FilesChangedCard } from "./messages/FilesChangedCard";
import { InlineMedia } from "./chat/InlineMedia";
import { OpenWithMenu } from "./chat/OpenWithMenu";
import { Lightbox } from "./chat/Lightbox";
import { UnifiedDiffViewer } from "./diff/UnifiedDiffViewer";
import { ensureMiniDom, flushMicrotasks } from "./test-utils/renderHook";
import type { FilesChangedSummaryMessage } from "./types";

function descendants(node: any): any[] {
  return [node, ...Array.from(node.childNodes ?? []).flatMap(descendants)];
}

function propsOf(node: any): Record<string, any> {
  const key = Object.keys(node).find((name) => name.startsWith("__reactProps$"));
  return key ? node[key] : {};
}

const authority = {
  cwd: "/cloud/workspace",
  sessionId: "session-also-valid-locally",
  sessionMainRootId: "root-also-valid-locally",
  rootStatus: "ok" as const,
};
const snapshot =
  "diff --git a/report.md b/report.md\n--- a/report.md\n+++ b/report.md\n@@ -1 +1 @@\n-old\n+new\n";
const changed: FilesChangedSummaryMessage = {
  kind: "files_changed",
  id: "remote-files",
  files: [{ path: "/cloud/workspace/report.md", added: 1, removed: 1, count: 1 }],
  totalAdded: 1,
  totalRemoved: 1,
};

describe("cloud transcript local capability boundary", () => {
  let root: Root;
  let container: HTMLElement;
  let originalBridge: typeof window.codeshell;
  let bridgeCalls: ReturnType<typeof mock>[];
  let openedFiles: unknown[];
  let reviewedFiles: unknown[];
  const onOpenFile = (event: Event) => openedFiles.push((event as CustomEvent).detail);
  const onReviewFiles = (event: Event) => reviewedFiles.push((event as CustomEvent).detail);

  beforeEach(() => {
    ensureMiniDom();
    originalBridge = window.codeshell;
    bridgeCalls = [];
    const local = (value: unknown) => {
      const fn = mock(async (..._args: unknown[]) => value);
      bridgeCalls.push(fn);
      return fn;
    };
    window.codeshell = {
      localFileExists: local(true),
      sessionFileExists: local(true),
      readImageDataUrl: local("data:image/png;base64,AA=="),
      getMediaPreview: local({ url: "csmedia://preview/local", kind: "audio", name: "voice.wav" }),
      releaseMediaPreview: local(undefined),
      openPath: local("/local/resolved"),
      revealInFinder: local(undefined),
      turnUndoState: local({ undoable: true, redoable: false }),
      undoTurn: local([]),
      redoTurn: local([]),
      getReviewDiff: local({ repositories: [], errors: [] }),
      saveImage: local("/local/saved.png"),
    } as unknown as typeof window.codeshell;
    openedFiles = [];
    reviewedFiles = [];
    window.addEventListener("codeshell:open-file", onOpenFile);
    window.addEventListener("codeshell:review-files", onReviewFiles);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
      await flushMicrotasks();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    document.body.removeChild(container);
    window.removeEventListener("codeshell:open-file", onOpenFile);
    window.removeEventListener("codeshell:review-files", onReviewFiles);
    window.codeshell = originalBridge;
  });

  async function render(children: React.ReactNode, localActions = false) {
    await act(async () => {
      root.render(
        <LocalRuntimeActionsContext.Provider value={localActions}>
          {children}
        </LocalRuntimeActionsContext.Provider>,
      );
      await flushMicrotasks();
    });
  }

  async function click(node: any) {
    await act(async () => {
      propsOf(node).onClick({
        preventDefault() {},
        stopPropagation() {},
        metaKey: false,
        ctrlKey: false,
      });
      await flushMicrotasks();
    });
  }

  function expectNoLocalActions() {
    for (const call of bridgeCalls) expect(call).not.toHaveBeenCalled();
    expect(openedFiles).toEqual([]);
    expect(reviewedFiles).toEqual([]);
  }

  test("absolute, relative, image, media and raw HTML paths never probe or open local files", async () => {
    await render(
      <Markdown
        {...authority}
        text={[
          "[absolute](/cloud/workspace/absolute.md)",
          "[relative](docs/relative.md)",
          "![image](/cloud/workspace/picture.png)",
          "[svg](diagram.svg)",
          "[audio](voice.wav)",
          "![video](movie.mp4)",
          '<img src="/cloud/workspace/raw.png" alt="raw image">',
          '<a href="file:///cloud/workspace/raw.md">raw file</a>',
        ].join("\n\n")}
      />,
    );
    expect(descendants(container).some((node) => node.tagName === "IMG")).toBe(false);
    expect(descendants(container).some((node) => propsOf(node)["data-path-link"])).toBe(false);
    expectNoLocalActions();
  });

  test("switching a resolved local path to cloud removes its cached local authority", async () => {
    const content = <Markdown {...authority} text="[cached](/cloud/workspace/cached.md)" />;
    await render(content, true);
    expect(window.codeshell.localFileExists).toHaveBeenCalledTimes(1);
    expect(descendants(container).some((node) => propsOf(node)["data-path-link"])).toBe(true);
    for (const call of bridgeCalls) call.mockClear();
    await render(content);
    expect(descendants(container).some((node) => propsOf(node)["data-path-link"])).toBe(false);
    expectNoLocalActions();
  });

  test("attachment and expanded file tool cards retain remote references without native actions", async () => {
    await render(
      <>
        {(["image", "audio", "video"] as const).map((kind) => (
          <AttachmentCard
            key={kind}
            attachment={{ kind, path: `/cloud/${kind}.png` }}
            {...authority}
          />
        ))}
        <FileToolCard
          {...authority}
          variant="write"
          message={{
            kind: "tool",
            id: "remote-write",
            toolName: "Write",
            status: "succeeded",
            startedAt: 1,
            args: JSON.stringify({ file_path: "/cloud/generated.png", content: "image" }),
          }}
        />
        <OpenWithMenu path="/cloud/menu.md">
          <button>Native action</button>
        </OpenWithMenu>
      </>,
    );
    const toggle = descendants(container).find((node) => propsOf(node)["aria-expanded"] === false);
    await click(toggle);
    expect(descendants(container).some((node) => propsOf(node)["aria-haspopup"] === "menu")).toBe(
      false,
    );
    for (const button of descendants(container).filter(
      (node) => node.tagName === "BUTTON" && propsOf(node).disabled,
    )) {
      if (propsOf(button).onClick) await click(button);
    }
    expectNoLocalActions();
  });

  test("direct media and live Git diff consumers reject remote session and root IDs", async () => {
    await render(
      <>
        <InlineMedia {...authority} path="/cloud/voice.wav" kind="audio" />
        <UnifiedDiffViewer
          cwd={authority.cwd}
          reviewSessionId={authority.sessionId}
          reviewRequest={{ kind: "working", mode: "all" }}
        />
      </>,
    );
    expect(descendants(container).some((node) => node.tagName === "AUDIO")).toBe(false);
    expectNoLocalActions();
  });

  test("cloud changed files have no undo probes, file open or local review dispatch", async () => {
    await render(
      <FilesChangedCard
        message={changed}
        cwd={authority.cwd}
        sessionId={authority.sessionId}
        isLatest
      />,
    );
    await click(descendants(container).find((node) => propsOf(node)["aria-expanded"] === false));
    expect(descendants(container).some((node) => node.tagName === "A")).toBe(false);
    expectNoLocalActions();
  });

  test("cloud snapshot review is readable and exposes no local open or comment action", async () => {
    await render(
      <FilesChangedCard
        message={{
          ...changed,
          sessionDiffs: [{ path: "report.md", toolCallId: "remote-edit", diff: snapshot }],
        }}
        cwd={authority.cwd}
        sessionId={authority.sessionId}
        isLatest
      />,
    );
    const review = descendants(container).find((node) =>
      propsOf(node)["aria-label"]?.includes("审核"),
    );
    expect(review).toBeDefined();
    await click(review);
    expect(descendants(container).some((node) => node.tagName === "TABLE")).toBe(true);
    expect(
      descendants(container).some((node) =>
        ["打开文件", "评论此行"].includes(propsOf(node)["aria-label"]),
      ),
    ).toBe(false);
    expectNoLocalActions();
  });

  test("remote lightbox can display supplied bytes without native save or reveal actions", async () => {
    await render(
      <Lightbox
        src="data:image/png;base64,AA=="
        alt="Cloud image"
        path="/cloud/picture.png"
        onClose={() => {}}
      />,
    );
    const buttons = descendants(document.body).filter((node) => node.tagName === "BUTTON");
    expect(
      buttons.some((node) => ["下载", "在文件夹中显示"].includes(propsOf(node)["aria-label"])),
    ).toBe(false);
    expectNoLocalActions();
  });
});
