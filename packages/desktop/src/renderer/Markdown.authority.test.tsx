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

function reactPropsOf(node: MiniElementNode): Record<string, any> {
  const current = node as unknown as Record<string, any>;
  const key = Object.keys(current).find((name) => name.startsWith("__reactProps$"));
  return key ? current[key] : {};
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
  test.each([
    { name: "without a project", cwd: null, sessionId: undefined, rootStatus: undefined },
    {
      name: "outside an unavailable project root",
      cwd: "/roots/unavailable",
      sessionId: "session-external-file",
      rootStatus: "root_replaced" as const,
    },
  ])("opens an existing absolute file $name without reading its contents", async (context) => {
    const path = context.sessionId
      ? "/outside-project/external.md"
      : "/outside-project/no-project.md";
    const checks: string[] = [];
    const opened: unknown[] = [];
    let contentReads = 0;
    let sessionChecks = 0;
    Object.assign(window, {
      codeshell: {
        localFileExists: async (candidate: string) => {
          checks.push(candidate);
          return true;
        },
        sessionFileExists: async () => {
          sessionChecks += 1;
          return false;
        },
        readLocalFilePreview: async () => {
          contentReads += 1;
        },
      },
    });
    const onOpen = (event: Event) => opened.push((event as CustomEvent).detail);
    window.addEventListener("codeshell:open-file", onOpen);
    try {
      await renderMarkdown(
        <Markdown
          text={`[report](${path})`}
          cwd={context.cwd}
          sessionId={context.sessionId}
          rootStatus={context.rootStatus}
        />,
      );

      const link = findPathLink(container!);
      expect(link?.getAttribute?.("title")).toBe(path);
      expect(checks).toEqual([path]);
      expect(sessionChecks).toBe(0);
      expect(contentReads).toBe(0);
      let prevented = false;
      reactPropsOf(link!).onClick({
        metaKey: false,
        ctrlKey: false,
        preventDefault: () => {
          prevented = true;
        },
      });
      expect(prevented).toBe(true);
      expect(opened).toEqual([{ path, cwd: context.cwd }]);
    } finally {
      window.removeEventListener("codeshell:open-file", onOpen);
    }
  });

  test.each(["missing", "failed"] as const)(
    "keeps an absolute file as plain text when its metadata check is %s",
    async (result) => {
      Object.assign(window, {
        codeshell: {
          localFileExists: async () => {
            if (result === "failed") throw new Error("File metadata unavailable");
            return false;
          },
        },
      });

      await renderMarkdown(<Markdown text={`[report](/outside-project/${result}.md)`} />);

      expect(findPathLink(container!)).toBeNull();
    },
  );

  test("uses Session authority for absolute links when local metadata checks are unavailable", async () => {
    const calls: Array<[string, string, string]> = [];
    Object.assign(window, {
      codeshell: {
        sessionFileExists: async (sessionId: string, rootId: string, path: string) => {
          calls.push([sessionId, rootId, path]);
          return true;
        },
      },
    });

    await renderMarkdown(
      <Markdown
        text="[web file](/roots/web-root/report.md)"
        sessionId="session-web-file"
        sessionMainRootId="web-root"
        rootStatus="ok"
      />,
    );

    expect(calls).toEqual([["session-web-file", "web-root", "/roots/web-root/report.md"]]);
    expect(findPathLink(container!)).not.toBeNull();
  });

  test("keeps absolute links inert without either local checks or Session authority", async () => {
    Object.assign(window, { codeshell: {} });

    await renderMarkdown(<Markdown text="[unavailable](/outside-project/no-bridge.md)" />);

    expect(findPathLink(container!)).toBeNull();
  });

  test("keeps denied images in an external document as explicit file links", async () => {
    const imageReads: Array<[string, unknown]> = [];
    let localReads = 0;
    const opened: unknown[] = [];
    Object.assign(window, {
      codeshell: {
        readImageDataUrl: async (path: string, context: unknown) => {
          imageReads.push([path, context]);
          throw new Error("project authority is required");
        },
        readLocalFilePreview: async () => {
          localReads += 1;
        },
      },
    });
    const onOpen = (event: Event) => opened.push((event as CustomEvent).detail);
    window.addEventListener("codeshell:open-file", onOpen);
    try {
      await renderMarkdown(<Markdown text="![Neighbour](diagram.png)" cwd="/outside-project" />);

      const link = findPathLink(container!);
      expect(imageReads).toEqual([["/outside-project/diagram.png", { cwd: "/outside-project" }]]);
      expect(localReads).toBe(0);
      expect(link).not.toBeNull();
      reactPropsOf(link!).onClick({
        metaKey: false,
        ctrlKey: false,
        preventDefault: () => undefined,
      });
      expect(opened).toEqual([{ path: "diagram.png", cwd: "/outside-project" }]);
    } finally {
      window.removeEventListener("codeshell:open-file", onOpen);
    }
  });

  test("re-resolves the same relative file against the migrated Session main root", async () => {
    const calls: Array<[string, string, string]> = [];
    let authorityCalls = 0;
    let localChecks = 0;
    Object.assign(window, {
      codeshell: {
        localFileExists: async () => {
          localChecks += 1;
          return true;
        },
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
    expect(localChecks).toBe(0);
    expect(findPathLink(container!)?.getAttribute?.("title")).toBe(
      "/roots/new-root/docs/same-relative.md",
    );
  });

  test.each(["dir_missing", "root_removed", "root_replaced"] as const)(
    "fails closed for relative files when rootStatus is %s",
    async (rootStatus) => {
      const calls: Array<[string, string, string]> = [];
      let localChecks = 0;
      Object.assign(window, {
        codeshell: {
          localFileExists: async () => {
            localChecks += 1;
            return true;
          },
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
      expect(localChecks).toBe(0);
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
