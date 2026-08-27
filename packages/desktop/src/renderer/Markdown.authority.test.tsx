import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { SessionWorkspaceAuthority } from "../preload/types";
import { ensureMiniDom, flushMicrotasks } from "./test-utils/renderHook";
import { Markdown } from "./Markdown";

interface MiniElementNode {
  tagName?: string;
  childNodes?: MiniElementNode[];
  getAttribute?(name: string): string | null;
}

function findPathLink(node: MiniElementNode): MiniElementNode | null {
  if (node.tagName === "A" && node.getAttribute?.("data-path-link") === "true") return node;
  for (const child of node.childNodes ?? []) {
    const found = findPathLink(child);
    if (found) return found;
  }
  return null;
}

let root: Root | null = null;
let container: HTMLElement | null = null;

beforeEach(() => {
  ensureMiniDom();
  container = document.createElement("div");
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => {
    root?.unmount();
    root = null;
    container = null;
    await flushMicrotasks();
  });
});

async function renderMarkdown(element: React.ReactElement): Promise<void> {
  await act(async () => {
    root?.render(element);
    await flushMicrotasks();
  });
}

async function remountMarkdown(element: React.ReactElement): Promise<void> {
  await act(async () => {
    root?.unmount();
    container = document.createElement("div");
    root = createRoot(container);
    root.render(element);
    await flushMicrotasks();
  });
}

function authority(mainRootId: string): SessionWorkspaceAuthority {
  return {
    workspace: { root: `/roots/${mainRootId}`, kind: "main" },
    projectId: "project-1",
    mainRootId,
    mainRoot: `/roots/${mainRootId}`,
    mainRootName: mainRootId,
    rootStatus: "ok",
  };
}

describe("Markdown Session root authority", () => {
  test("re-resolves the same relative file against the migrated Session main root", async () => {
    const calls: Array<[string, string, string]> = [];
    let authorityCalls = 0;
    Object.assign(window, {
      codeshell: {
        getSessionWorkspaceAuthority: async () => {
          authorityCalls += 1;
          return authority("old-root");
        },
        sessionFileExists: async (sessionId: string, rootId: string, path: string) => {
          calls.push([sessionId, rootId, path]);
          return true;
        },
      },
    });

    await renderMarkdown(
      <Markdown
        text="[same file](docs/same-relative.md)"
        cwd="/roots/old-root"
        sessionId="session-migrate"
        sessionMainRootId="old-root"
        rootStatus="ok"
      />,
    );
    expect(calls).toEqual([["session-migrate", "old-root", "docs/same-relative.md"]]);
    expect(findPathLink(container!)?.getAttribute?.("title")).toBe(
      "/roots/old-root/docs/same-relative.md",
    );

    await remountMarkdown(
      <Markdown
        text="[same file](docs/same-relative.md)"
        cwd="/roots/new-root"
        sessionId="session-migrate"
        sessionMainRootId="new-root"
        rootStatus="ok"
      />,
    );
    expect(calls).toEqual([
      ["session-migrate", "old-root", "docs/same-relative.md"],
      ["session-migrate", "new-root", "docs/same-relative.md"],
    ]);
    expect(authorityCalls).toBe(0);
    expect(findPathLink(container!)?.getAttribute?.("title")).toBe(
      "/roots/new-root/docs/same-relative.md",
    );
  });

  test.each(["dir_missing", "root_removed", "root_replaced"] as const)(
    "fails closed for relative files when rootStatus is %s",
    async (rootStatus) => {
      const calls: Array<[string, string, string]> = [];
      Object.assign(window, {
        codeshell: {
          getSessionWorkspaceAuthority: async () => authority("old-root"),
          sessionFileExists: async (sessionId: string, rootId: string, path: string) => {
            calls.push([sessionId, rootId, path]);
            return true;
          },
        },
      });

      await renderMarkdown(
        <Markdown
          text="[missing authority](docs/status.md)"
          cwd={null}
          sessionId={`session-${rootStatus}`}
          sessionMainRootId="old-root"
          rootStatus={rootStatus}
        />,
      );

      expect(calls).toEqual([]);
      expect(findPathLink(container!)).toBeNull();
    },
  );

  test("does not expose a relative image link while Session root authority is unavailable", async () => {
    let imageReads = 0;
    Object.assign(window, {
      codeshell: {
        readImageDataUrl: async () => {
          imageReads += 1;
          return "data:image/png;base64,AA==";
        },
      },
    });

    await renderMarkdown(
      <Markdown
        text="![status](docs/status.png)"
        cwd={null}
        sessionId="session-image-replaced"
        sessionMainRootId="old-root"
        rootStatus="root_replaced"
      />,
    );

    expect(imageReads).toBe(0);
    expect(findPathLink(container!)).toBeNull();
  });
});
