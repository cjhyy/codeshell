import { expect, test } from "bun:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { UnifiedDiffViewer } from "./UnifiedDiffViewer";
import { withHeaderOnlyGitPatch } from "./headerOnlyGit.fixture";
import { ensureMiniDom, flushMicrotasks } from "../test-utils/renderHook";

function descendants(node: any): any[] {
  return [node, ...Array.from(node.childNodes ?? []).flatMap(descendants)];
}
function propsOf(node: any): Record<string, any> {
  const key = Object.keys(node).find((name) => name.startsWith("__reactProps$"));
  return key ? node[key] : {};
}

test("actual React Review titles and plain-click open callbacks use owned Git header-only paths", async () => {
  await withHeaderOnlyGitPatch(async ({ cwd, raw, expected }) => {
    ensureMiniDom();
    const priorBridge = window.codeshell;
    const calls: unknown[] = [],
      opens: unknown[] = [];
    window.codeshell = {
      getReviewDiff: async (sessionId: string, request: unknown) => {
        calls.push({ sessionId, request });
        return { repositories: [{ rootId: "owned-root", repoRoot: cwd, diff: raw }], errors: [] };
      },
      openPath: () => {
        throw new Error("Plain Review click must not open an OS app");
      },
    } as unknown as typeof window.codeshell;
    const onOpen = (event: Event) => opens.push((event as CustomEvent).detail);
    window.addEventListener("codeshell:open-file", onOpen);
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(
          <UnifiedDiffViewer
            cwd={cwd}
            reviewSessionId="owned-session"
            reviewRequest={{ kind: "working", mode: "staged" }}
          />,
        );
        await flushMicrotasks();
      });
      const nodes = descendants(container);
      const titles = nodes
        .filter(
          (node) =>
            node.tagName === "SPAN" && propsOf(node).className === "truncate font-mono text-xs",
        )
        .map((node) => propsOf(node).title);
      const buttons = nodes.filter((node) => propsOf(node).role === "button");
      for (const button of buttons)
        await act(async () => {
          propsOf(button).onClick({
            stopPropagation() {},
            preventDefault() {},
            metaKey: false,
            ctrlKey: false,
          });
          await flushMicrotasks();
        });
      console.log(JSON.stringify({ scenario: "actual-react-header-only-review", titles, opens }));
      const paths = expected.map((file) => file.newPath ?? file.oldPath);
      expect(calls).toEqual([
        { sessionId: "owned-session", request: { kind: "working", mode: "staged" } },
      ]);
      expect([...titles].sort()).toEqual([...paths].sort());
      expect(opens).toHaveLength(paths.length);
      expect(opens).toEqual(titles.map((path) => ({ path: `${cwd}/${path}`, cwd })));
      await act(async () => {
        root.render(<UnifiedDiffViewer cwd={cwd} diffText={raw} onlyPath="new empty.txt" />);
        await flushMicrotasks();
      });
      const selected = descendants(container)
        .filter(
          (node) =>
            node.tagName === "SPAN" && propsOf(node).className === "truncate font-mono text-xs",
        )
        .map((node) => propsOf(node).title);
      expect(selected).toEqual(["new empty.txt"]);
      expect(calls).toHaveLength(1); // onlyPath is the turn-snapshot route, not a Git query.
    } finally {
      await act(async () => {
        root.unmount();
        await flushMicrotasks();
      });
      document.body.removeChild(container);
      window.removeEventListener("codeshell:open-file", onOpen);
      window.codeshell = priorBridge;
    }
  });
});
